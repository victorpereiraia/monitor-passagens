import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";

const ALVO_POR_PESSOA = 2700;
const DESTINOS = ["MCO", "FLL", "MIA", "TPA"];

// Extrair --horas N se fornecido
const horasIdx = process.argv.indexOf("--horas");
const horas = horasIdx !== -1 && horasIdx + 1 < process.argv.length
  ? Number(process.argv[horasIdx + 1])
  : 3;

const url = process.env.SUPABASE_URL?.trim();
const chave = process.env.SUPABASE_SECRET_KEY?.trim();
const resendApiKey = process.env.RESEND_API_KEY?.trim();
const emailDestino = process.env.EMAIL_DESTINO?.trim();

if (!url || !chave || !resendApiKey || !emailDestino) {
  console.error("Faltam variáveis de ambiente: SUPABASE_URL, SUPABASE_SECRET_KEY, RESEND_API_KEY, EMAIL_DESTINO");
  process.exit(1);
}

const supabase = createClient(url, chave);
const resend = new Resend(resendApiKey);

const agora = new Date();
const inicioHoje = new Date(agora.getTime() - horas * 60 * 60 * 1000);
const inicioHojeISO = inicioHoje.toISOString();

/** Consulta coletas de hoje com paginação para evitar limite de 1000 linhas. */
async function buscarColetasHoje() {
  const todas = [];
  let offset = 0;
  const limite = 1000;
  
  while (true) {
    const { data, error } = await supabase
      .from("precos")
      .select("*")
      .gte("coletado_em", inicioHojeISO)
      .order("preco_por_pessoa", { ascending: true })
      .range(offset, offset + limite - 1);
    
    if (error) {
      console.error("Erro ao buscar coletas de hoje:", error.message);
      return null;
    }
    
    if (!data || data.length === 0) break;
    
    todas.push(...data);
    if (data.length < limite) break;
    offset += limite;
  }
  
  return todas;
}

/** Conta linhas por destino usando count exact. */
async function contarLinhasPorDestino() {
  const contagens = {};
  
  for (const destino of DESTINOS) {
    const { count, error } = await supabase
      .from("precos")
      .select("*", { count: "exact", head: true })
      .gte("coletado_em", inicioHojeISO)
      .eq("destino", destino);
    
    if (error) {
      console.error(`Erro ao contar linhas para ${destino}:`, error.message);
      contagens[destino] = null;
    } else {
      contagens[destino] = count ?? 0;
    }
  }
  
  return contagens;
}

/** Busca menor preço da coleta anterior (entre inicioHoje - 36h e inicioHoje - 12h). */
async function buscarMenorPrecoColetaAnterior() {
  const inicioAnterior = new Date(inicioHoje.getTime() - 36 * 60 * 60 * 1000).toISOString();
  const fimAnterior = new Date(inicioHoje.getTime() - 12 * 60 * 60 * 1000).toISOString();
  
  const { data, error } = await supabase
    .from("precos")
    .select("preco_por_pessoa")
    .gte("coletado_em", inicioAnterior)
    .lt("coletado_em", fimAnterior)
    .order("preco_por_pessoa", { ascending: true })
    .limit(1)
    .single();
  
  if (error || !data) {
    return null;
  }
  
  return data.preco_por_pessoa;
}

/** Busca menor preço histórico de toda a tabela. */
async function buscarMenorPrecoHistorico() {
  const { data, error } = await supabase
    .from("precos")
    .select("preco_por_pessoa")
    .order("preco_por_pessoa", { ascending: true })
    .limit(1)
    .single();
  
  if (error || !data) {
    return null;
  }
  
  return data.preco_por_pessoa;
}

/** Menor preço por destino nas coletas de hoje. */
async function menorPrecoPorDestino(coletasHoje) {
  const menores = {};
  
  for (const destino of DESTINOS) {
    const doDestino = coletasHoje.filter(c => c.destino === destino);
    if (doDestino.length === 0) {
      menores[destino] = null;
    } else {
      menores[destino] = Math.min(...doDestino.map(c => c.preco_por_pessoa));
    }
  }
  
  return menores;
}

/** Gera link do Google Flights para a viagem. */
function gerarLinkGoogleFlights(opcao) {
  const q = `Flights%20to%20${opcao.destino}%20from%20${opcao.origem}%20on%20${opcao.data_ida}%20through%20${opcao.data_volta}`;
  return `https://www.google.com/travel/flights?q=${q}`;
}

/** Formata diferença de preço. */
function formatarDiferenca(precoAtual, precoAnterior) {
  const diff = precoAtual - precoAnterior;
  const diffAbs = Math.abs(diff);
  const pct = (diffAbs / precoAnterior) * 100;
  
  if (diff > 0) {
    return `+R$ ${diffAbs.toFixed(0)} (+${pct.toFixed(1)}%)`;
  } else {
    return `-R$ ${diffAbs.toFixed(0)} (-${pct.toFixed(1)}%)`;
  }
}

// --- Execução principal ---
console.log(`Buscando coletas das últimas ${horas} horas...`);

const coletasHoje = await buscarColetasHoje();

if (!coletasHoje || coletasHoje.length === 0) {
  console.log("Nenhuma coleta encontrada hoje. Enviando e-mail de aviso...");
  
  const { error } = await resend.emails.send({
    from: "Monitor de Passagens <onboarding@resend.dev>",
    to: emailDestino,
    subject: "O monitor não gravou preços hoje",
    text: "O monitor de passagens não gravou nenhum preço hoje.\n\nVerifique se as execuções estão rodando corretamente.",
  });
  
  if (error) {
    console.error("Erro ao enviar e-mail:", error.message);
    process.exit(1);
  }
  
  console.log("E-mail enviado com sucesso.");
  process.exit(0);
}

console.log(`Encontradas ${coletasHoje.length} coletas.`);

// 5 opções mais baratas
const top5 = [...coletasHoje].sort((a, b) => a.preco_por_pessoa - b.preco_por_pessoa).slice(0, 5);

// Menor preço por destino
const menoresPorDestino = await menorPrecoPorDestino(coletasHoje);

// Contagem por destino
const contagensPorDestino = await contarLinhasPorDestino();

// Menor preço da coleta anterior
const menorPrecoAnterior = await buscarMenorPrecoColetaAnterior();

// Menor preço histórico
const menorPrecoHistorico = await buscarMenorPrecoHistorico();

// Montar e-mail
const menorHoje = top5[0];
const link = gerarLinkGoogleFlights(menorHoje);

let corpo = `🔥 Menor preço de hoje\n\n`;
corpo += `${menorHoje.origem} → ${menorHoje.destino}\n`;
corpo += `Ida: ${menorHoje.data_ida} | Volta: ${menorHoje.data_volta}\n`;
corpo += `Companhia: ${menorHoje.companhias}\n`;
corpo += `Paradas: ${menorHoje.paradas} | Duração: ${menorHoje.duracao}\n`;
corpo += `Preço por pessoa: R$ ${menorHoje.preco_por_pessoa.toFixed(2)}\n`;
corpo += `Total para 4 adultos: R$ ${(menorHoje.preco_por_pessoa * 4).toFixed(2)}\n`;
corpo += `${link}\n\n`;

// Comparação com coleta anterior
corpo += `📊 Comparação\n\n`;
if (menorPrecoAnterior !== null) {
  const diff = formatarDiferenca(menorHoje.preco_por_pessoa, menorPrecoAnterior);
  corpo += `Coleta anterior: R$ ${menorPrecoAnterior.toFixed(2)}\n`;
  corpo += `Hoje: ${diff}\n\n`;
} else {
  corpo += `Coleta anterior: sem dados\n\n`;
}

// Comparação com histórico
if (menorPrecoHistorico !== null) {
  corpo += `Menor preço histórico: R$ ${menorPrecoHistorico.toFixed(2)}\n`;
  const diffHistorico = menorHoje.preco_por_pessoa - menorPrecoHistorico;
  corpo += `Distância do histórico: ${diffHistorico > 0 ? '+' : ''}R$ ${diffHistorico.toFixed(2)}\n\n`;
} else {
  corpo += `Menor preço histórico: sem dados\n\n`;
}

// Distância do alvo
const diffAlvo = menorHoje.preco_por_pessoa - ALVO_POR_PESSOA;
if (diffAlvo < 0) {
  corpo += `✅ Alvo (R$ ${ALVO_POR_PESSOA}): R$ ${Math.abs(diffAlvo).toFixed(2)} abaixo\n\n`;
} else {
  corpo += `Alvo (R$ ${ALVO_POR_PESSOA}): R$ ${diffAlvo.toFixed(2)} acima\n\n`;
}

// 5 mais baratas
corpo += `🏆 5 mais baratas de hoje\n\n`;
for (let i = 0; i < top5.length; i++) {
  const o = top5[i];
  corpo += `${i + 1}. ${o.origem}→${o.destino} | ${o.data_ida} | R$ ${o.preco_por_pessoa.toFixed(0)}\n`;
}
corpo += "\n";

// Menor preço por destino
corpo += `💰 Menor preço por destino\n\n`;
for (const destino of DESTINOS) {
  const menor = menoresPorDestino[destino];
  if (menor !== null) {
    corpo += `${destino}: R$ ${menor.toFixed(2)}\n`;
  } else {
    corpo += `${destino}: sem dados\n`;
  }
}
corpo += "\n";

// Coletas por destino
corpo += `📋 Coletas de hoje: `;
const partes = [];
for (const destino of DESTINOS) {
  const count = contagensPorDestino[destino];
  if (count === 0) {
    partes.push(`${destino} ⚠️`);
  } else if (count === null) {
    partes.push(`${destino} erro`);
  } else {
    partes.push(`${destino} ${count}`);
  }
}
corpo += partes.join(", ") + "\n";

// Enviar e-mail
const assunto = `✈️ Resumo do dia: menor preço R$ ${menorHoje.preco_por_pessoa.toFixed(0)} por pessoa (${menorHoje.origem}→${menorHoje.destino})`;

console.log("Enviando e-mail de resumo...");

const { error } = await resend.emails.send({
  from: "Monitor de Passagens <onboarding@resend.dev>",
  to: emailDestino,
  subject: assunto,
  text: corpo,
});

if (error) {
  console.error("Erro ao enviar e-mail:", error.message);
  process.exit(1);
}

console.log("E-mail enviado com sucesso.");
