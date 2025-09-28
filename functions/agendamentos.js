import { authMiddleware } from './auth.js';
import { accessSpreadsheet, ensureDynamicHeaders, horarioDisponivel, updateRowInSheet, supabase } from './config.js';

export async function handler(event) {
  try {
    const path = event.path;
    const httpMethod = event.httpMethod;
    const pathParams = event.pathParameters || {};
    const queryParams = event.queryStringParameters || {};
    
    // Rota: GET /agendamentos/:cliente
    if (path.includes('/agendamentos/') && httpMethod === 'GET') {
      const cliente = pathParams.cliente;
      
      // Autenticação
      const auth = await authMiddleware(event);
      if (auth.error) return auth.error;
      
      if (auth.clienteId !== cliente) {
        return { statusCode: 403, body: JSON.stringify({ msg: "Acesso negado" }) };
      }

      const { data, error } = await supabase
        .from("agendamentos")
        .select("*")
        .eq("cliente", cliente)
        .neq("status", "cancelado")
        .order("data", { ascending: true })
        .order("horario", { ascending: true });

      if (error) throw error;
      return { statusCode: 200, body: JSON.stringify({ agendamentos: data }) };
    }

    // Rota: POST /agendar/:cliente
    if (path.includes('/agendar/') && httpMethod === 'POST') {
      const cliente = pathParams.cliente;
      
      // Autenticação
      const auth = await authMiddleware(event);
      if (auth.error) return auth.error;
      
      if (auth.clienteId !== cliente) {
        return { statusCode: 403, body: JSON.stringify({ msg: "Acesso negado" }) };
      }

      const { Nome, Email, Telefone, Data, Horario } = JSON.parse(event.body);
      if (!Nome || !Email || !Telefone || !Data || !Horario) {
        return { statusCode: 400, body: JSON.stringify({ msg: "Todos os campos obrigatórios" }) };
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
      const doc = await accessSpreadsheet(cliente);
      const sheet = doc.sheetsByIndex[0];
      await ensureDynamicHeaders(sheet, Object.keys(novoAgendamento));
      await sheet.addRow(novoAgendamento);

      return { 
        statusCode: 200, 
        body: JSON.stringify({ 
          msg: "Agendamento realizado com sucesso!", 
          agendamento: novoAgendamento 
        }) 
      };
    }

    // Rota: POST /agendamentos/:cliente/confirmar/:id
    if (path.includes('/confirmar/') && httpMethod === 'POST') {
      const { cliente, id } = pathParams;
      
      // Autenticação
      const auth = await authMiddleware(event);
      if (auth.error) return auth.error;
      
      if (auth.clienteId !== cliente) {
        return { statusCode: 403, body: JSON.stringify({ msg: "Acesso negado" }) };
      }

      const { data } = await supabase.from("agendamentos")
        .update({ confirmado: true, status: "confirmado" })
        .eq("id", id).eq("cliente", cliente).select().single();

      const doc = await accessSpreadsheet(cliente);
      await updateRowInSheet(doc.sheetsByIndex[0], id, data);

      return { 
        statusCode: 200, 
        body: JSON.stringify({ msg: "Agendamento confirmado", agendamento: data }) 
      };
    }

    // Rota: POST /agendamentos/:cliente/cancelar/:id
    if (path.includes('/cancelar/') && httpMethod === 'POST') {
      const { cliente, id } = pathParams;
      
      // Autenticação
      const auth = await authMiddleware(event);
      if (auth.error) return auth.error;
      
      if (auth.clienteId !== cliente) {
        return { statusCode: 403, body: JSON.stringify({ msg: "Acesso negado" }) };
      }

      const { data } = await supabase.from("agendamentos")
        .update({ status: "cancelado", confirmado: false })
        .eq("id", id).eq("cliente", cliente).select().single();

      const doc = await accessSpreadsheet(cliente);
      await updateRowInSheet(doc.sheetsByIndex[0], id, data);

      return { 
        statusCode: 200, 
        body: JSON.stringify({ msg: "Agendamento cancelado", agendamento: data }) 
      };
    }

    // Rota: POST /agendamentos/:cliente/reagendar/:id
    if (path.includes('/reagendar/') && httpMethod === 'POST') {
      const { cliente, id } = pathParams;
      const { novaData, novoHorario } = JSON.parse(event.body);
      
      if (!novaData || !novoHorario) {
        return { statusCode: 400, body: JSON.stringify({ msg: "Data e horário obrigatórios" }) };
      }

      // Autenticação
      const auth = await authMiddleware(event);
      if (auth.error) return auth.error;
      
      if (auth.clienteId !== cliente) {
        return { statusCode: 403, body: JSON.stringify({ msg: "Acesso negado" }) };
      }

      const disponivel = await horarioDisponivel(cliente, novaData, novoHorario, id);
      if (!disponivel) {
        return { statusCode: 400, body: JSON.stringify({ msg: "Horário indisponível" }) };
      }

      const { data } = await supabase.from("agendamentos")
        .update({ data: novaData, horario: novoHorario })
        .eq("id", id).eq("cliente", cliente).select().single();

      const doc = await accessSpreadsheet(cliente);
      await updateRowInSheet(doc.sheetsByIndex[0], id, data);

      return { 
        statusCode: 200, 
        body: JSON.stringify({ msg: "Agendamento reagendado com sucesso", agendamento: data }) 
      };
    }

    // Rota não encontrada
    return { statusCode: 404, body: JSON.stringify({ msg: "Rota não encontrada" }) };

  } catch (err) {
    console.error("Erro interno:", err);
    return { statusCode: 500, body: JSON.stringify({ msg: "Erro interno" }) };
  }
}