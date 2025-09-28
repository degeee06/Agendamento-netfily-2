import { createClient } from "@supabase/supabase-js";
import { GoogleSpreadsheet } from "google-spreadsheet";
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

let creds = null;

try {
  if (process.env.GOOGLE_SERVICE_ACCOUNT) {
    // Remove escapes e corrige quebras de linha
    const credsJson = process.env.GOOGLE_SERVICE_ACCOUNT
      .replace(/\\n/g, '\n')  // Corrige \\n para \n
      .replace(/\\\\/g, '\\'); // Corrige escapes duplos
    
    creds = JSON.parse(credsJson);
    console.log('✅ Google Sheets creds carregadas com sucesso');
  }
} catch (e) {
  console.error("❌ Erro ao parsear GOOGLE_SERVICE_ACCOUNT:", e);
  console.log('🔍 JSON problemático:', process.env.GOOGLE_SERVICE_ACCOUNT?.substring(0, 200));
}
// ---------------- Funções do Google Sheets CORRIGIDAS ----------------
async function accessSpreadsheet(clienteId) {
  const { data, error } = await supabase
    .from("clientes")
    .select("spreadsheet_id")
    .eq("id", clienteId)
    .single();
  if (error || !data) throw new Error(`Cliente ${clienteId} não encontrado`);

  const doc = new GoogleSpreadsheet(data.spreadsheet_id);
  await doc.useServiceAccountAuth(creds); // ✅ Mantém igual
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

// ---------------- Middleware Auth ----------------
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

    let clienteId = data.user.user_metadata?.cliente_id;
    
    if (!clienteId) {
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
      clienteId = "cliente1";
    }

    return { user: data.user, clienteId };
    
  } catch (error) {
    console.error("❌ Erro no authMiddleware:", error);
    return { error: { statusCode: 500, body: JSON.stringify({ msg: "Erro de autenticação" }) } };
  }
}

// ---------------- Função para extrair cliente CORRIGIDA ----------------
function extractClienteFromPath(path, httpMethod) {
  const pathParts = path.split('/').filter(part => part);
  
  // ✅ Para rotas simples: /api/agendamentos/cliente1 ou /api/agendar/cliente1
  if (httpMethod === 'GET' || path.includes('/agendar/')) {
    for (let i = pathParts.length - 1; i >= 0; i--) {
      if (pathParts[i] && pathParts[i] !== 'api' && pathParts[i] !== 'agendamentos' && pathParts[i] !== 'agendar') {
        return pathParts[i];
      }
    }
  }
  
  // ✅ Para rotas com ID: /api/agendamentos/cliente1/cancelar/ID
  if (path.includes('/cancelar/') || path.includes('/confirmar/') || path.includes('/reagendar/')) {
    // O cliente é sempre o penúltimo elemento antes da ação
    for (let i = 0; i < pathParts.length; i++) {
      if (pathParts[i] === 'agendamentos' && i + 1 < pathParts.length) {
        return pathParts[i + 1];
      }
    }
  }
  
  return null;
}

export async function handler(event) {
  console.log('🚀 Function iniciada para:', event.path);
  
  try {
    const path = event.path;
    const httpMethod = event.httpMethod;
    const pathParams = event.pathParameters || {};
    
    console.log('📦 Parâmetros:', { path, httpMethod, pathParams });

    // ✅ CORREÇÃO: Extrai cliente de forma inteligente baseada na rota
    let cliente = extractClienteFromPath(path, httpMethod);
    
    console.log('👤 Cliente extraído:', cliente);

    if (!cliente) {
      return { 
        statusCode: 400, 
        body: JSON.stringify({ msg: "Cliente não especificado na URL" }) 
      };
    }

    const auth = await authMiddleware(event);
    if (auth.error) return auth.error;
    
    // ✅ Verificação de acesso (agora fora do switch para todas as rotas)
    if (auth.clienteId !== cliente && auth.clienteId !== "admin") {
      return { 
        statusCode: 403, 
        body: JSON.stringify({ msg: "Acesso negado" }) 
      };
    }

    // ---------------- LISTAR AGENDAMENTOS ----------------
    if (path.includes('/agendamentos/') && httpMethod === 'GET') {      
      const { data: agendamentos, error } = await supabase
        .from("agendamentos")
        .select("*")
        .eq("cliente", cliente)
        .neq("status", "cancelado")
        .order("data", { ascending: true })
        .order("horario", { ascending: true });

      if (error) throw error;
      
      return { 
        statusCode: 200, 
        body: JSON.stringify({ agendamentos: agendamentos || [] }) 
      };
    }

    // ---------------- AGENDAR ----------------
    if (path.includes('/agendar/') && httpMethod === 'POST') {
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

      // Atualiza Google Sheet (opcional)
      try {
        if (creds) {
          const doc = await accessSpreadsheet(cliente);
          const sheet = doc.sheetsByIndex[0];
          await ensureDynamicHeaders(sheet, Object.keys(novoAgendamento));
          await sheet.addRow(novoAgendamento);
        }
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

    // ---------------- CANCELAR AGENDAMENTO ----------------
    if ((path.includes('/cancelar/') || path.includes('/confirmar/') || path.includes('/reagendar/')) && httpMethod === 'POST') {
      // ✅ CORREÇÃO: Extrai o ID do agendamento da URL
      const pathParts = path.split('/');
      const id = pathParts[pathParts.length - 1]; // Último elemento é o ID
      
      console.log('🆔 ID do agendamento:', id);

      if (!id) {
        return { 
          statusCode: 400, 
          body: JSON.stringify({ msg: "ID do agendamento não especificado" }) 
        };
      }

      // ---------------- CANCELAR ----------------
      if (path.includes('/cancelar/')) {
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
          if (creds) {
            const doc = await accessSpreadsheet(cliente);
            await updateRowInSheet(doc.sheetsByIndex[0], id, data);
          }
        } catch (sheetError) {
          console.error('⚠️ Erro ao atualizar Google Sheets:', sheetError);
        }

        return { 
          statusCode: 200, 
          body: JSON.stringify({ msg: "Agendamento cancelado", agendamento: data }) 
        };
      }

      // ---------------- CONFIRMAR ----------------
      if (path.includes('/confirmar/')) {
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
          if (creds) {
            const doc = await accessSpreadsheet(cliente);
            await updateRowInSheet(doc.sheetsByIndex[0], id, data);
          }
        } catch (sheetError) {
          console.error('⚠️ Erro ao atualizar Google Sheets:', sheetError);
        }

        return { 
          statusCode: 200, 
          body: JSON.stringify({ msg: "Agendamento confirmado", agendamento: data }) 
        };
      }

      // ---------------- REAGENDAR ----------------
      if (path.includes('/reagendar/')) {
        const { novaData, novoHorario } = JSON.parse(event.body);
        
        if (!novaData || !novoHorario) {
          return { 
            statusCode: 400, 
            body: JSON.stringify({ msg: "Data e horário obrigatórios" }) 
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
          if (creds) {
            const doc = await accessSpreadsheet(cliente);
            await updateRowInSheet(doc.sheetsByIndex[0], id, data);
          }
        } catch (sheetError) {
          console.error('⚠️ Erro ao atualizar Google Sheets:', sheetError);
        }

        return { 
          statusCode: 200, 
          body: JSON.stringify({ msg: "Agendamento reagendado com sucesso", agendamento: data }) 
        };
      }
    }

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

