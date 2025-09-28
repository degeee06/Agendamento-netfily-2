import { supabase } from './config.js';

export async function authMiddleware(event) {
  const token = event.headers.authorization?.split("Bearer ")[1];
  if (!token) {
    return { error: { statusCode: 401, body: JSON.stringify({ msg: "Token não enviado" }) } };
  }

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) {
    return { error: { statusCode: 401, body: JSON.stringify({ msg: "Token inválido" }) } };
  }

  const clienteId = data.user.user_metadata.cliente_id;
  if (!clienteId) {
    return { error: { statusCode: 403, body: JSON.stringify({ msg: "Usuário sem cliente_id" }) } };
  }

  return { user: data.user, clienteId };
}