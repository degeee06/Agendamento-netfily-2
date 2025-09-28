import { createClient } from "@supabase/supabase-js";
import { GoogleSpreadsheet } from "google-spreadsheet";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

let creds;
try {
  creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
} catch (e) {
  console.error("Erro ao parsear GOOGLE_SERVICE_ACCOUNT:", e);
}

// ---------------- Funções do Google Sheets ----------------
async function accessSpreadsheet(clienteId) {
  const { data, error } = await supabase
    .from("clientes")
    .select("spreadsheet_id")
    .eq("id", clienteId)
    .single();
  if (error || !data) throw new Error(`Cliente ${clienteId} não encontrado`);

  const doc = new GoogleSpreadsheet(data.spreadsheet_id);
  await doc.useServiceAccountAuth(creds);
  await doc.loadInfo();
  return doc;
}

async function ensureDynamicHeaders(sheet, newKeys) {
  await sheet.loadHeaderRow().catch(async () => await sheet.setHeaderRow(newKeys));
  const currentHeaders = sheet.headerValues || [];
  const headersToAdd = newKeys.filter((k) => !currentHeaders.includes(k));
  if (headersToAdd.length > 0) {
    await sheet.setHeaderRow([...currentHeaders, ...headersToAdd]);
  }
}

async function updateRowInSheet(sheet, rowId, updatedData) {
  await sheet.loadHeaderRow();
  const rows = await sheet.getRows();
  const row = rows.find(r => r.id === rowId);
  if (row) {
    Object.keys(updatedData).forEach(key => {
      if (sheet.headerValues.includes(key)) row[key] = updatedData[key];
    });
    await row.save();
  } else {
    await ensureDynamicHeaders(sheet, Object.keys(updatedData));
    await sheet.addRow(updatedData);
  }
}

async function horarioDisponivel(cliente, data, horario, ignoreId = null) {
  let query = supabase
    .from("agendamentos")
    .select("*")
    .eq("cliente", cliente)
    .eq("data", data)
    .eq("horario", horario)
    .neq("status", "cancelado");

  if (ignoreId) query = query.neq("id", ignoreId);
  const { data: agendamentos } = await query;
  return agendamentos.length === 0;
}

// ---------------- Middleware Auth CORRIGIDO ----------------
async function authMiddleware(event) {
  const token = event.headers.authorization?.split("Bearer ")[1];
  if (!token) {
    return { error: { statusCode: 401, body: JSON.stringify({ msg: "Token não enviado" }) } };
  }

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) {
    return { error: { statusCode: 401, body: JSON.stringify({ msg: "Token inválido" }) } };
  }

  // ✅ CORREÇÃO: Pega cliente_id de forma mais flexível
  const clienteId = data.user.user_metadata?.cliente_id || 
                   data.user.app_metadata?.cliente_id ||
                   data.user.email?.split('@')[0]; // fallback para parte do email

  if (!clienteId) {
    return { error: { statusCode: 403, body: JSON.stringify({ msg: "Usuário sem cliente_id" }) } };
  }

  return { user: data.user, clienteId };
}

// ---------------- Handler Principal ----------------
export async function handler(event) {
  try {
    const path = event.path;
    const httpMethod = event.httpMethod;
    const pathParams = event.pathParameters || {};
    
    console.log('📦 Recebido:', { path, httpMethod, pathParams });

    // ---------------- LISTAR AGENDAMENTOS ----------------
    if (path.includes('/agendamentos/') && httpMethod === 'GET') {
      const cliente = pathParams.cliente;
      
      console.log('🔍 Cliente da URL:', cliente);
      
      const auth = await authMiddleware(event);
      if (auth.error) {
        console.log('❌ Erro de auth:', auth.error);
        return auth.error;
      }
      
      console.log('✅ Usuário autenticado:', auth.user.email);
      console.log('🔑 Cliente do token:', auth.clienteId);
      
      // ✅ CORREÇÃO: Verificação mais flexível
      if (auth.clienteId.toString() !== cliente.toString()) {
        console.log('⚠️ Cliente mismatch:', {
          tokenCliente: auth.clienteId,
          urlCliente: cliente
        });
        
        return { 
          statusCode: 403, 
          body: JSON.stringify({ 
            msg: "Acesso negado",
            details: {
              tokenCliente: auth.clienteId,
              requestedCliente: cliente
            }
          }) 
        };
      }

      const { data, error } = await supabase
        .from("agendamentos")
        .select("*")
        .eq("cliente", cliente)
        .neq("status", "cancelado")
        .order("data", { ascending: true })
        .order("horario", { ascending: true });

      if (error) throw error;
      
      console.log('📊 Agendamentos encontrados:', data.length);
      
      return { 
        statusCode: 200, 
        body: JSON.stringify({ agendamentos: data }) 
      };
    }

    // ---------------- AGENDAR ----------------
    if (path.includes('/agendar/') && httpMethod === 'POST') {
      const cliente = pathParams.cliente;
      
      const auth = await authMiddleware(event);
      if (auth.error) return auth.error;
      
      // ✅ CORREÇÃO: Verificação mais flexível
      if (auth.clienteId.toString() !== cliente.toString()) {
        return { 
          statusCode: 403, 
          body: JSON.stringify({ msg: "Acesso negado" }) 
        };
      }

      const { Nome, Email, Telefone, Data, Horario } = JSON.parse(event.body);
      
      if (!Nome || !Email || !Telefone || !Data || !Horario) {
        return { 
          statusCode: 400, 
          body: JSON.stringify({ msg: "Todos os campos obrigatórios" }) 
        };
      }

      const emailNormalizado = Email.toLowerCase().trim();
      const dataNormalizada = new Date(Data).toISOString().split("T")[0];

      // Limpeza de agendamentos cancelados
      await supabase
        .from("agendamentos")
        .delete()
        .eq("cliente", cliente)
        .eq("data", dataNormalizada)
        .eq("horario", Horario)
        .eq("status", "cancelado");

      // Inserção do agendamento
      const { data: novoAgendamento, error } = await supabase
        .from("agendamentos")
        .insert([{
          cliente,
          nome: Nome,
          email: emailNormalizado,
          telefone: Telefone,
          data: dataNormalizada,
          horario: Horario,
          status: "pendente",
          confirmado: false,
        }])
        .select()
        .single();

      if (error) throw error;

      // Atualiza Google Sheet
      try {
        const doc = await accessSpreadsheet(cliente);
        const sheet = doc.sheetsByIndex[0];
        await ensureDynamicHeaders(sheet, Object.keys(novoAgendamento));
        await sheet.addRow(novoAgendamento);
      } catch (sheetError) {
        console.error('⚠️ Erro ao atualizar Google Sheets:', sheetError);
      }

      return { 
        statusCode: 200, 
        body: JSON.stringify({ 
          msg: "Agendamento realizado com sucesso!", 
          agendamento: novoAgendamento 
        }) 
      };
    }

    // ---------------- CONFIRMAR AGENDAMENTO ----------------
    if (path.includes('/confirmar/') && httpMethod === 'POST') {
      const { cliente, id } = pathParams;
      
      const auth = await authMiddleware(event);
      if (auth.error) return auth.error;
      
      // ✅ CORREÇÃO: Verificação mais flexível
      if (auth.clienteId.toString() !== cliente.toString()) {
        return { 
          statusCode: 403, 
          body: JSON.stringify({ msg: "Acesso negado" }) 
        };
      }

      const { data, error } = await supabase
        .from("agendamentos")
        .update({ confirmado: true, status: "confirmado" })
        .eq("id", id)
        .eq("cliente", cliente)
        .select()
        .single();

      if (error) throw error;

      // Atualiza Google Sheet
      try {
        const doc = await accessSpreadsheet(cliente);
        await updateRowInSheet(doc.sheetsByIndex[0], id, data);
      } catch (sheetError) {
        console.error('⚠️ Erro ao atualizar Google Sheets:', sheetError);
      }

      return { 
        statusCode: 200, 
        body: JSON.stringify({ msg: "Agendamento confirmado", agendamento: data }) 
      };
    }

    // ---------------- CANCELAR AGENDAMENTO ----------------
    if (path.includes('/cancelar/') && httpMethod === 'POST') {
      const { cliente, id } = pathParams;
      
      const auth = await authMiddleware(event);
      if (auth.error) return auth.error;
      
      // ✅ CORREÇÃO: Verificação mais flexível
      if (auth.clienteId.toString() !== cliente.toString()) {
        return { 
          statusCode: 403, 
          body: JSON.stringify({ msg: "Acesso negado" }) 
        };
      }

      const { data, error } = await supabase
        .from("agendamentos")
        .update({ status: "cancelado", confirmado: false })
        .eq("id", id)
        .eq("cliente", cliente)
        .select()
        .single();

      if (error) throw error;

      // Atualiza Google Sheet
      try {
        const doc = await accessSpreadsheet(cliente);
        await updateRowInSheet(doc.sheetsByIndex[0], id, data);
      } catch (sheetError) {
        console.error('⚠️ Erro ao atualizar Google Sheets:', sheetError);
      }

      return { 
        statusCode: 200, 
        body: JSON.stringify({ msg: "Agendamento cancelado", agendamento: data }) 
      };
    }

    // ---------------- REAGENDAR ----------------
    if (path.includes('/reagendar/') && httpMethod === 'POST') {
      const { cliente, id } = pathParams;
      const { novaData, novoHorario } = JSON.parse(event.body);
      
      if (!novaData || !novoHorario) {
        return { 
          statusCode: 400, 
          body: JSON.stringify({ msg: "Data e horário obrigatórios" }) 
        };
      }

      const auth = await authMiddleware(event);
      if (auth.error) return auth.error;
      
      // ✅ CORREÇÃO: Verificação mais flexível
      if (auth.clienteId.toString() !== cliente.toString()) {
        return { 
          statusCode: 403, 
          body: JSON.stringify({ msg: "Acesso negado" }) 
        };
      }

      const disponivel = await horarioDisponivel(cliente, novaData, novoHorario, id);
      if (!disponivel) {
        return { 
          statusCode: 400, 
          body: JSON.stringify({ msg: "Horário indisponível" }) 
        };
      }

      const { data, error } = await supabase
        .from("agendamentos")
        .update({ data: novaData, horario: novoHorario })
        .eq("id", id)
        .eq("cliente", cliente)
        .select()
        .single();

      if (error) throw error;

      // Atualiza Google Sheet
      try {
        const doc = await accessSpreadsheet(cliente);
        await updateRowInSheet(doc.sheetsByIndex[0], id, data);
      } catch (sheetError) {
        console.error('⚠️ Erro ao atualizar Google Sheets:', sheetError);
      }

      return { 
        statusCode: 200, 
        body: JSON.stringify({ msg: "Agendamento reagendado com sucesso", agendamento: data }) 
      };
    }

    // Rota não encontrada
    return { 
      statusCode: 404, 
      body: JSON.stringify({ msg: "Rota não encontrada" }) 
    };

  } catch (err) {
    console.error("❌ Erro interno:", err);
    return { 
      statusCode: 500, 
      body: JSON.stringify({ msg: "Erro interno no servidor" }) 
    };
  }
}
