import { supabase } from './config.js';

export async function handler(event) {
  try {
    const { cliente } = event.pathParameters;
    
    // Buscar configurações do cliente
    const { data, error } = await supabase
      .from("clientes")
      .select("*")
      .eq("id", cliente)
      .single();

    if (error || !data) {
      return {
        statusCode: 404,
        body: JSON.stringify({ msg: "Cliente não encontrado" })
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ cliente: data })
    };

  } catch (err) {
    console.error("Erro ao buscar cliente:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ msg: "Erro interno" })
    };
  }
}