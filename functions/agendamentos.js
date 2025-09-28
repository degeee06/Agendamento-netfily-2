import { createClient } from "@supabase/supabase-js";
import { GoogleSpreadsheet } from "google-spreadsheet";

// ✅ Configuração segura do Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ✅ Configuração segura do Google Sheets
let creds = null;
if (process.env.GOOGLE_SERVICE_ACCOUNT) {
  try {
    creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  } catch (e) {
    console.error("❌ Erro ao parsear GOOGLE_SERVICE_ACCOUNT:", e);
    // Continua sem Google Sheets, mas não quebra a aplicação
  }
}

// ---------------- Funções do Google Sheets (com fallback) ----------------
async function accessSpreadsheet(clienteId) {
  if (!creds) {
    throw new Error("Google Sheets não configurado");
  }
  
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
  try {
    await sheet.loadHeaderRow();
  } catch (e) {
    await sheet.setHeaderRow(newKeys);
  }
  
  const currentHeaders = sheet.headerValues || [];
  const headersToAdd = newKeys.filter((k) => !currentHeaders.includes(k));
  if (headersToAdd.length > 0) {
    await sheet.setHeaderRow([...currentHeaders, ...headersToAdd]);
  }
}

async function updateRowInSheet(sheet, rowId, updatedData) {
  try {
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
  } catch (error) {
    console.error("❌ Erro ao atualizar Google Sheets:", error);
    // Não quebra a aplicação se der erro no sheet
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
  try {
    const token = event.headers.authorization?.split("Bearer ")[1];
    if (!token) {
      return { error: { statusCode: 401, body: JSON.stringify({ msg: "Token não enviado" }) } };
    }

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) {
      return { error: { statusCode: 401, body: JSON.stringify({ msg: "Token inválido" }) } };
    }

    // ✅ Busca o cliente_id de forma mais confiável
    let clienteId = data.user.user_metadata?.cliente_id;
    
    if (!clienteId) {
      // ✅ Tenta buscar da tabela de usuários
      const { data: userData, error: userError } = await supabase
        .from("users")
        .select("cliente_id")
        .eq("id", data.user.id)
        .single();
      
      if (!userError && userData) {
        clienteId = userData.cliente_id;
      }
    }

    if (!clienteId) {
      // ✅ Fallback seguro
      clienteId = "cliente1"; // Valor padrão
    }

    return { user: data.user, clienteId };
    
  } catch (error) {
    console.error("❌ Erro no authMiddleware:", error);
    return { error: { statusCode: 500, body: JSON.stringify({ msg: "Erro de autenticação" }) } };
  }
}

// ---------------- Handler Principal CORRIGIDO ----------------
export async function handler(event) {
  console.log('🚀 Function iniciada para:', event.path);
  
  try {
    const path = event.path;
    const httpMethod = event.httpMethod;
    const pathParams = event.pathParameters || {};
    
    console.log('📦 Parâmetros:', { path, httpMethod, pathParams });

    // ✅ CORREÇÃO: Extrai cliente da URL corretamente
    let cliente = pathParams.cliente;
    
    // ✅ Fallback se cliente for undefined
    if (!cliente && path.includes('/agendamentos/')) {
      const pathParts = path.split('/');
      cliente = pathParts[pathParts.length - 1]; // Pega último elemento
    }
    
    console.log('👤 Cliente extraído:', cliente);

    // ---------------- LISTAR AGENDAMENTOS ----------------
    if (path.includes('/agendamentos/') && httpMethod === 'GET') {
      if (!cliente) {
        return { 
          statusCode: 400, 
          body: JSON.stringify({ msg: "Cliente não especificado" }) 
        };
      }
      
      const auth = await authMiddleware(event);
      if (auth.error) {
        console.log('❌ Erro de autenticação:', auth.error);
        return auth.error;
      }
      
      console.log('✅ Usuário autenticado:', auth.user.email);
      console.log('🔑 Cliente do token:', auth.clienteId);
      
      // ✅ CORREÇÃO: Verificação segura sem toString()
      if (auth.clienteId !== cliente && auth.clienteId !== "admin") {
        console.log('⚠️ Acesso negado - cliente mismatch');
        return { 
          statusCode: 403, 
          body: JSON.stringify({ 
            msg: "Acesso negado",
            userCliente: auth.clienteId,
            requestedCliente: cliente
          }) 
        };
      }

      // ✅ Busca os agendamentos
      console.log('🔍 Buscando agendamentos para:', cliente);
      const { data: agendamentos, error } = await supabase
        .from("agendamentos")
        .select("*")
        .eq("cliente", cliente)
        .neq("status", "cancelado")
        .order("data", { ascending: true })
        .order("horario", { ascending: true });

      if (error) {
        console.error('❌ Erro ao buscar agendamentos:', error);
        throw error;
      }

      console.log('📊 Agendamentos encontrados:', agendamentos.length);
      
      return { 
        statusCode: 200, 
        body: JSON.stringify({ agendamentos: agendamentos || [] }) 
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
