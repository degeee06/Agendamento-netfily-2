import { accessSpreadsheet, ensureDynamicHeaders, updateRowInSheet } from './config.js';

export async function handler(event) {
  // Funções específicas do Google Sheets se necessário
  return {
    statusCode: 200,
    body: JSON.stringify({ message: "Google Sheets functions" })
  };
}