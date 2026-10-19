import { writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { createQuery, Passengers, getFlights } from "fast-flights-ts";
import { Resend } from "resend";

// --- Configuração (edite aqui) ---
const CONFIG = {
  origens: ["GRU", "VCP"], // CGH pode ser testado depois
  destinos: ["MCO", "FLL", "MIA", "TPA"],
  primeiraSaida: "2026-12-01",
  ultimaSaida: "2027-02-01",
  passoDias: 1,
  duracaoDias: 14,
  adultos: 4,
  criancas: 0,
  bebes: 0,
  cabine: "economy",
  moeda: "BRL",
  pausaMs: 4000,
  precoAlvoPorPessoa: 2700,
  precoMinimoPorPessoa: 500,
  /** Queda acima disso em relação ao menor preço recente da mesma viagem dispara nova busca de confirmação. */
  quedaSuspeita: 0.5,
  diasHistoricoSanidade: 3,
  /** Se true, divide o preço da API pelo número de adultos (total do grupo). */
  precoEhTotalDoGrupo: true,
};

const modoTeste = process.argv.includes("--teste");
const salvarSupabase = process.argv.includes("--salvar");
const verificarPreco = process.argv.includes("--verificar");
const alertar = process.argv.includes("--alertar");

// Extrair --alvo N se fornecido
const alvoIdx = process.argv.indexOf("--alvo");
const alvoOverride = alvoIdx !== -1 && alvoIdx + 1 < process.argv.length
  ? Number(process.argv[alvoIdx + 1])
  : null;
const precoAlvoAtual = alvoOverride ?? CONFIG.precoAlvoPorPessoa;

// Extrair --destino XXX se fornecido
const destinoIdx = process.argv.indexOf("--destino");
const destinoOverride = destinoIdx !== -1 && destinoIdx + 1 < process.argv.length
  ? process.argv[destinoIdx + 1]
  : null;

// Validar e aplicar --destino
let destinosAtuais = CONFIG.destinos;
let destinoSufixo = "";
if (destinoOverride) {
  if (!CONFIG.destinos.includes(destinoOverride)) {
    console.error(`Erro: destino "${destinoOverride}" não está na lista de destinos do CONFIG.`);
    console.error(`Destinos válidos: ${CONFIG.destinos.join(", ")}`);
    process.exit(1);
  }
  destinosAtuais = [destinoOverride];
  destinoSufixo = `[${destinoOverride}] `;
}

const PAUSA_RETRY_MS = 10_000;

let buscasOk = 0;
let buscasFalha = 0;
let opcoesDescartadasTotal = 0;
let falhasSeguidas = 0;
let interrompidoPorFalhas = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Soma dias a uma data YYYY-MM-DD (meio-dia UTC evita bug de fuso). */
function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Todas as datas de ida dentro da janela. */
function gerarDatasIda() {
  const datas = [];
  let atual = CONFIG.primeiraSaida;
  while (atual <= CONFIG.ultimaSaida) {
    datas.push(atual);
    atual = addDays(atual, CONFIG.passoDias);
  }
  return datas;
}

/** Combinações origem × destino × data de ida (volta calculada). */
function gerarCombinacoes() {
  const combos = [];
  for (const origem of CONFIG.origens) {
    for (const destino of destinosAtuais) {
      for (const dataIda of gerarDatasIda()) {
        combos.push({
          origem,
          destino,
          dataIda,
          dataVolta: addDays(dataIda, CONFIG.duracaoDias),
        });
      }
    }
  }
  return combos;
}

function criarPassageiros({ adultos, criancas, bebes }) {
  return new Passengers({
    adults: adultos,
    children: criancas,
    infants_on_lap: bebes,
  });
}

function montarQuery(combo, passageiros) {
  return createQuery({
    flights: [
      {
        date: combo.dataIda,
        from_airport: combo.origem,
        to_airport: combo.destino,
      },
      {
        date: combo.dataVolta,
        from_airport: combo.destino,
        to_airport: combo.origem,
      },
    ],
    seat: CONFIG.cabine,
    trip: "round-trip",
    passengers: passageiros,
    currency: CONFIG.moeda,
  });
}

/** Busca com até 2 novas tentativas após falha (10 s entre tentativas). */
async function buscarComRetry(query, rotulo) {
  const maxTentativas = 3;
  let ultimoErro;
  for (let t = 1; t <= maxTentativas; t++) {
    try {
      const results = await getFlights(query);
      buscasOk += 1;
      return results;
    } catch (err) {
      ultimoErro = err;
      if (t < maxTentativas) {
        console.log(
          `  ⚠ ${rotulo}: falha (${err.message}). Tentativa ${t + 1}/${maxTentativas} em ${PAUSA_RETRY_MS / 1000}s...`,
        );
        await sleep(PAUSA_RETRY_MS);
      }
    }
  }
  buscasFalha += 1;
  falhasSeguidas += 1;
  throw ultimoErro;
}

/** Paradas na ida e na volta (trechos − 1 por perna). */
function contarParadas(segments, destino) {
  let i = 0;
  let ida = 0;
  while (i < segments.length && segments[i].to_airport.code !== destino) {
    ida++;
    i++;
  }
  if (i < segments.length) ida++;
  const paradasIda = Math.max(0, ida - 1);

  let volta = 0;
  while (i < segments.length) {
    volta++;
    i++;
  }
  const paradasVolta = Math.max(0, volta - 1);

  return paradasIda + paradasVolta;
}

function formatarDuracao(minutos) {
  const h = Math.floor(minutos / 60);
  const m = minutos % 60;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

/**
 * Compara busca com 1 adulto vs grupo configurado para saber se o preço
 * da API é total do grupo ou por pessoa.
 */
async function verificarTipoPreco(primeiraCombo) {
  console.log("\n=== Verificação de preço (1 adulto vs grupo) ===\n");

  const q1 = montarQuery(primeiraCombo, criarPassageiros({ adultos: 1, criancas: 0, bebes: 0 }));
  const r1 = await buscarComRetry(q1, "verificação 1 adulto");
  await sleep(CONFIG.pausaMs);

  const qN = montarQuery(
    primeiraCombo,
    criarPassageiros({
      adultos: CONFIG.adultos,
      criancas: CONFIG.criancas,
      bebes: CONFIG.bebes,
    }),
  );
  const rN = await buscarComRetry(qN, `verificação ${CONFIG.adultos} adultos`);

  const p1 = r1.length ? Math.min(...r1.map((f) => f.price)) : null;
  const pN = rN.length ? Math.min(...rN.map((f) => f.price)) : null;

  console.log(`  Menor preço com 1 adulto:    ${p1 != null ? `R$ ${p1}` : "sem voos"}`);
  console.log(
    `  Menor preço com ${CONFIG.adultos} adultos: ${pN != null ? `R$ ${pN}` : "sem voos"}`,
  );

  let modo = "por_pessoa";
  let divisor = 1;

  if (p1 != null && pN != null && p1 > 0) {
    const razao = pN / p1;
    const esperadoTotal = CONFIG.adultos;
    const tol = 0.15;
    if (Math.abs(razao - esperadoTotal) / esperadoTotal <= tol) {
      modo = "total_grupo";
      divisor = CONFIG.adultos;
      console.log(
        `\n  Conclusão: preço parece TOTAL do grupo (≈ ${razao.toFixed(1)}× o de 1 adulto). Dividir por ${CONFIG.adultos} para comparar com o alvo.\n`,
      );
    } else {
      console.log(
        `\n  Conclusão: preço parece POR PESSOA (não escala ~${CONFIG.adultos}× com mais adultos).\n`,
      );
    }
  } else {
    console.log("\n  Conclusão: não foi possível comparar (faltou resultado em alguma busca).\n");
  }

  return { modo, divisor, amostra: { preco1Adulto: p1, precoGrupo: pN } };
}

/** Tipo de preço a partir do CONFIG (sem buscas extras). */
function tipoPrecoFromConfig() {
  if (CONFIG.precoEhTotalDoGrupo) {
    return {
      modo: "total_grupo",
      divisor: CONFIG.adultos,
      amostra: null,
      fonte: "config",
    };
  }
  return { modo: "por_pessoa", divisor: 1, amostra: null, fonte: "config" };
}

function precoApiValido(preco) {
  if (preco == null || preco === "") return false;
  const n = Number(preco);
  return Number.isFinite(n) && n > 0;
}

function precoPorPessoa(precoApi, tipoPreco) {
  if (tipoPreco.modo === "total_grupo") {
    return precoApi / tipoPreco.divisor;
  }
  return precoApi;
}

function voosParaOpcoes(combo, results, tipoPreco) {
  const brutas = results.map((v) => {
    const duracaoMin = v.flights.reduce((s, leg) => s + leg.duration, 0);
    const precoApi = v.price;
    const porPessoa = precoPorPessoa(precoApi, tipoPreco);
    const precoPorPessoaArred = Math.round(porPessoa * 100) / 100;
    return {
      origem: combo.origem,
      destino: combo.destino,
      dataIda: combo.dataIda,
      dataVolta: combo.dataVolta,
      companhias: [...v.airlines],
      paradas: contarParadas(v.flights, combo.destino),
      duracaoMinutos: duracaoMin,
      duracaoTexto: formatarDuracao(duracaoMin),
      precoApi,
      precoPorPessoa: precoPorPessoaArred,
      abaixoDoAlvo: precoPorPessoaArred < precoAlvoAtual,
    };
  });

  return filtrarOpcoesValidas(brutas);
}

/** Remove preço inválido ou abaixo do mínimo de sanidade. */
function filtrarOpcoesValidas(opcoes) {
  const validas = [];
  let descartadas = 0;

  for (const o of opcoes) {
    if (!precoApiValido(o.precoApi)) {
      descartadas += 1;
      continue;
    }
    if (o.precoPorPessoa < CONFIG.precoMinimoPorPessoa) {
      descartadas += 1;
      continue;
    }
    o.abaixoDoAlvo = o.precoPorPessoa < precoAlvoAtual;
    validas.push(o);
  }

  opcoesDescartadasTotal += descartadas;
  return validas;
}

/** Converte opções do monitor em linhas da tabela precos. */
function opcoesParaLinhasSupabase(opcoes) {
  return opcoes.map((o) => ({
    origem: o.origem,
    destino: o.destino,
    data_ida: o.dataIda,
    data_volta: o.dataVolta,
    companhias: o.companhias.join(", "),
    paradas: o.paradas,
    duracao: o.duracaoTexto,
    preco_total: o.precoApi,
    preco_por_pessoa: o.precoPorPessoa,
  }));
}

/** Grava opções no Supabase em lotes de 100. */
async function gravarPrecosNoSupabase(opcoes) {
  const url = process.env.SUPABASE_URL?.trim();
  const chave = process.env.SUPABASE_SECRET_KEY?.trim();

  if (!url || !chave) {
    console.error(
      "\nNão foi possível gravar no Supabase: faltam SUPABASE_URL e/ou SUPABASE_SECRET_KEY no ambiente.\n" +
        "Defina-as no arquivo .env e rode com: node --env-file=.env monitor.mjs ... --salvar",
    );
    return { gravadas: 0, falhou: true };
  }

  const supabase = createClient(url, chave);
  const linhas = opcoesParaLinhasSupabase(opcoes);
  const tamanhoLote = 100;
  let gravadas = 0;

  console.log(`\n=== Gravando no Supabase (${linhas.length} linhas) ===\n`);

  for (let i = 0; i < linhas.length; i += tamanhoLote) {
    const lote = linhas.slice(i, i + tamanhoLote);
    const numeroLote = Math.floor(i / tamanhoLote) + 1;
    const { error } = await supabase.from("precos").insert(lote);

    if (error) {
      console.error(
        `Erro ao gravar o lote ${numeroLote} no Supabase (já gravadas ${gravadas} linhas nesta execução).`,
      );
      console.error(`Mensagem do Supabase: ${error.message}`);
      if (error.details) console.error(`Detalhes: ${error.details}`);
      if (error.hint) console.error(`Dica: ${error.hint}`);
      return { gravadas, falhou: true };
    }

    gravadas += lote.length;
    console.log(`  Lote ${numeroLote}: ${lote.length} linhas gravadas (${gravadas}/${linhas.length})`);
  }

  return { gravadas, falhou: false };
}

/** Chave única para identificar uma viagem (origem|destino|data_ida|data_volta). */
function chaveViagem(opcao) {
  return `${opcao.origem}|${opcao.destino}|${opcao.dataIda}|${opcao.dataVolta}`;
}

/** Busca alertas anteriores no Supabase para as viagens fornecidas. */
async function buscarAlertasAnteriores(viagens) {
  const url = process.env.SUPABASE_URL?.trim();
  const chave = process.env.SUPABASE_SECRET_KEY?.trim();

  if (!url || !chave) {
    console.error("\nNão foi possível consultar alertas: faltam SUPABASE_URL e/ou SUPABASE_SECRET_KEY.");
    return {};
  }

  const supabase = createClient(url, chave);
  const datasIda = [...new Set(viagens.map((v) => v.dataIda))];

  // A tabela alertas não tem coluna "chave": filtra por destino/data e monta a chave aqui
  const { data, error } = await supabase
    .from("alertas")
    .select("origem, destino, data_ida, data_volta, preco_por_pessoa")
    .in("destino", destinosAtuais)
    .in("data_ida", datasIda)
    .order("enviado_em", { ascending: true });

  if (error) {
    console.error("Erro ao buscar alertas anteriores:", error.message);
    return {};
  }

  // Mapa: chave -> último preço avisado (ordem crescente, o mais recente sobrescreve)
  const mapa = {};
  for (const alerta of data ?? []) {
    const chaveAlerta = chaveViagem({
      origem: alerta.origem,
      destino: alerta.destino,
      dataIda: alerta.data_ida,
      dataVolta: alerta.data_volta,
    });
    mapa[chaveAlerta] = Number(alerta.preco_por_pessoa);
  }
  return mapa;
}

/** Menor preço por pessoa de cada viagem nas coletas dos últimos dias (antes desta execução). */
async function buscarMenoresPrecosRecentes() {
  const url = process.env.SUPABASE_URL?.trim();
  const chave = process.env.SUPABASE_SECRET_KEY?.trim();

  if (!url || !chave) {
    console.log("\nChecagem de sanidade pulada: faltam SUPABASE_URL e/ou SUPABASE_SECRET_KEY.");
    return null;
  }

  const supabase = createClient(url, chave);
  const desde = new Date(inicio - CONFIG.diasHistoricoSanidade * 24 * 60 * 60 * 1000).toISOString();
  const ate = new Date(inicio).toISOString();
  const mapa = {};
  const tamanhoPagina = 1000;

  for (let offset = 0; ; offset += tamanhoPagina) {
    const { data, error } = await supabase
      .from("precos")
      .select("origem, destino, data_ida, data_volta, preco_por_pessoa")
      .in("destino", destinosAtuais)
      .gte("coletado_em", desde)
      .lt("coletado_em", ate)
      .order("id", { ascending: true })
      .range(offset, offset + tamanhoPagina - 1);

    if (error) {
      console.error("Erro ao buscar histórico para checagem de sanidade:", error.message);
      return null;
    }

    for (const r of data) {
      const chaveHist = chaveViagem({
        origem: r.origem,
        destino: r.destino,
        dataIda: r.data_ida,
        dataVolta: r.data_volta,
      });
      const preco = Number(r.preco_por_pessoa);
      if (mapa[chaveHist] === undefined || preco < mapa[chaveHist]) {
        mapa[chaveHist] = preco;
      }
    }

    if (data.length < tamanhoPagina) break;
  }

  return mapa;
}

/**
 * Viagens cujo menor preço caiu mais que CONFIG.quedaSuspeita em relação ao histórico
 * recente são buscadas de novo. Se a nova busca não confirmar a queda, as opções
 * suspeitas são trocadas pelas da nova busca; se a nova busca falhar, são descartadas.
 */
async function revalidarQuedasSuspeitas(opcoes) {
  const historico = await buscarMenoresPrecosRecentes();
  if (!historico) return { opcoes, suspeitas: 0, corrigidas: 0, confirmadas: 0 };

  const porViagem = {};
  for (const o of opcoes) {
    (porViagem[chaveViagem(o)] ??= []).push(o);
  }

  let suspeitas = 0;
  let corrigidas = 0;
  let confirmadas = 0;
  const resultado = [];

  for (const [chave, doTrecho] of Object.entries(porViagem)) {
    const minimoAtual = Math.min(...doTrecho.map((o) => o.precoPorPessoa));
    const minimoAnterior = historico[chave];

    if (minimoAnterior === undefined || minimoAtual >= minimoAnterior * (1 - CONFIG.quedaSuspeita)) {
      resultado.push(...doTrecho);
      continue;
    }

    suspeitas += 1;
    const { origem, destino, dataIda, dataVolta } = doTrecho[0];
    const combo = { origem, destino, dataIda, dataVolta };
    console.log(
      `\n⚠ Queda suspeita ${origem}→${destino} ida ${dataIda}: R$ ${minimoAtual.toFixed(0)} hoje vs ` +
        `R$ ${minimoAnterior.toFixed(0)} nos últimos ${CONFIG.diasHistoricoSanidade} dias. Buscando de novo...`,
    );

    await sleep(CONFIG.pausaMs);
    try {
      const query = montarQuery(
        combo,
        criarPassageiros({ adultos: CONFIG.adultos, criancas: CONFIG.criancas, bebes: CONFIG.bebes }),
      );
      const novas = voosParaOpcoes(combo, await buscarComRetry(query, `revalidação ${origem}→${destino} ${dataIda}`), tipoPreco);
      const novoMinimo = novas.length ? Math.min(...novas.map((o) => o.precoPorPessoa)) : null;

      if (novoMinimo !== null && novoMinimo < minimoAnterior * (1 - CONFIG.quedaSuspeita)) {
        confirmadas += 1;
        console.log(`  → Confirmada: nova busca trouxe R$ ${novoMinimo.toFixed(0)}.`);
      } else {
        corrigidas += 1;
        console.log(
          `  → Não confirmada: nova busca trouxe ${novoMinimo !== null ? `R$ ${novoMinimo.toFixed(0)}` : "nenhuma opção"}. Usando a nova busca.`,
        );
      }
      resultado.push(...novas);
    } catch (err) {
      corrigidas += 1;
      console.log(`  → Nova busca falhou (${err.message}). Opções suspeitas descartadas.`);
    }
  }

  return { opcoes: resultado, suspeitas, corrigidas, confirmadas };
}

/** Filtra viagens que precisam de alerta (abaixo do alvo e não avisadas ou preço menor). */
function filtrarViagensParaAlertar(opcoes, alertasAnteriores, alvo) {
  const abaixoDoAlvo = opcoes.filter(o => o.precoPorPessoa < alvo);
  
  // Para cada viagem, ficar só com a opção mais barata
  const porViagem = {};
  for (const o of abaixoDoAlvo) {
    const chave = chaveViagem(o);
    if (!porViagem[chave] || o.precoPorPessoa < porViagem[chave].precoPorPessoa) {
      porViagem[chave] = o;
    }
  }

  const melhores = Object.values(porViagem);
  const paraAlertar = [];

  for (const o of melhores) {
    const chave = chaveViagem(o);
    const ultimoPreco = alertasAnteriores[chave];
    
    // Nunca avisado ou preço pelo menos R$ 50 menor
    if (ultimoPreco === undefined || o.precoPorPessoa <= ultimoPreco - 50) {
      paraAlertar.push(o);
    }
  }

  return paraAlertar.sort((a, b) => a.precoPorPessoa - b.precoPorPessoa);
}

/** Gera link do Google Flights para a viagem. */
function gerarLinkGoogleFlights(opcao) {
  const q = `Flights%20to%20${opcao.destino}%20from%20${opcao.origem}%20on%20${opcao.dataIda}%20through%20${opcao.dataVolta}`;
  return `https://www.google.com/travel/flights?q=${q}`;
}

/** Envia e-mail de alerta com as viagens encontradas. */
async function enviarEmailAlerta(viagens, alvo) {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const destino = process.env.EMAIL_DESTINO?.trim();

  if (!apiKey || !destino) {
    console.error("\nNão foi possível enviar alerta: faltam RESEND_API_KEY e/ou EMAIL_DESTINO.");
    return { enviado: false, erro: "faltam variáveis de ambiente" };
  }

  const resend = new Resend(apiKey);
  const top10 = viagens.slice(0, 10);
  
  // Assunto com a primeira viagem mais barata
  const primeira = top10[0];
  const assunto = `${destinoSufixo}✈️ Passagem abaixo de R$ ${alvo.toFixed(0)} por pessoa: ${primeira.origem}→${primeira.destino} R$ ${primeira.precoPorPessoa.toFixed(0)}`;

  let corpo = `${destinoSufixo}Encontrei passagens abaixo do seu alvo de preço:\n\n`;
  for (const v of top10) {
    const link = gerarLinkGoogleFlights(v);
    corpo += `${v.origem} → ${v.destino}\n`;
    corpo += `  Ida: ${v.dataIda} | Volta: ${v.dataVolta}\n`;
    corpo += `  Companhias: ${v.companhias.join(", ")}\n`;
    corpo += `  Paradas: ${v.paradas} | Duração: ${v.duracaoTexto}\n`;
    corpo += `  Preço por pessoa: R$ ${v.precoPorPessoa.toFixed(2)}\n`;
    corpo += `  Total para ${CONFIG.adultos} adultos: R$ ${(v.precoPorPessoa * CONFIG.adultos).toFixed(2)}\n`;
    corpo += `  ${link}\n\n`;
  }

  corpo += "Bons voos! 🛫";

  const { data, error } = await resend.emails.send({
    from: "Monitor de Passagens <onboarding@resend.dev>",
    to: destino,
    subject: assunto,
    text: corpo,
  });

  if (error) {
    console.error("Erro ao enviar e-mail de alerta:", error.message);
    return { enviado: false, erro: error.message };
  }

  console.log(`\n✅ E-mail de alerta enviado para ${destino} (ID: ${data.id})`);
  return { enviado: true, id: data.id };
}

/** Grava alertas na tabela alertas do Supabase. */
async function gravarAlertasNoSupabase(viagens) {
  const url = process.env.SUPABASE_URL?.trim();
  const chave = process.env.SUPABASE_SECRET_KEY?.trim();

  if (!url || !chave) {
    console.error("\nNão foi possível gravar alertas: faltam SUPABASE_URL e/ou SUPABASE_SECRET_KEY.");
    return { gravadas: 0, falhou: true };
  }

  const supabase = createClient(url, chave);
  const linhas = viagens.map(o => ({
    origem: o.origem,
    destino: o.destino,
    data_ida: o.dataIda,
    data_volta: o.dataVolta,
    companhias: o.companhias.join(", "),
    preco_por_pessoa: o.precoPorPessoa,
    preco_total: o.precoApi,
  }));

  const { error } = await supabase.from("alertas").insert(linhas);

  if (error) {
    console.error("Erro ao gravar alertas:", error.message);
    return { gravadas: 0, falhou: true };
  }

  console.log(`Alertas gravados: ${linhas.length} viagem(ns)`);
  return { gravadas: linhas.length, falhou: false };
}

/** Envia e-mail de falha quando --alertar está ativo. */
async function enviarEmailFalha(motivo) {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const destino = process.env.EMAIL_DESTINO?.trim();

  if (!apiKey || !destino) {
    console.error("\nNão foi possível enviar aviso de falha: faltam RESEND_API_KEY e/ou EMAIL_DESTINO.");
    return;
  }

  const resend = new Resend(apiKey);

  const { error } = await resend.emails.send({
    from: "Monitor de Passagens <onboarding@resend.dev>",
    to: destino,
    subject: `${destinoSufixo}O monitor de passagens teve problemas hoje`,
    text: `${destinoSufixo}O monitor de passagens teve problemas hoje.\n\nMotivo: ${motivo}\n\nVerifique os logs para mais detalhes.`,
  });

  if (error) {
    console.error("Erro ao enviar e-mail de falha:", error.message);
  } else {
    console.log("\n✅ E-mail de falha enviado.");
  }
}

function imprimirTabelaTop10(opcoes) {
  const top = [...opcoes].sort((a, b) => a.precoPorPessoa - b.precoPorPessoa).slice(0, 10);

  console.log("\n=== 10 opções mais baratas (preço por pessoa) ===\n");
  console.log(
    "OK  Orig  Dest  Ida        Volta      Companhia(s)              Paradas  Duração    R$/pessoa",
  );
  console.log("-".repeat(95));

  for (const o of top) {
    const marca = o.abaixoDoAlvo ? "✅" : "  ";
    const comps = o.companhias.join("+").slice(0, 24).padEnd(24);
    console.log(
      `${marca}  ${o.origem}  ${o.destino}  ${o.dataIda}  ${o.dataVolta}  ${comps}  ${String(o.paradas).padStart(7)}  ${o.duracaoTexto.padStart(9)}  ${o.precoPorPessoa.toFixed(0)}`,
    );
  }
}

// --- Execução principal ---
const inicio = Date.now();
const todasCombinacoes = gerarCombinacoes();
const combinacoes = modoTeste ? todasCombinacoes.slice(0, 3) : todasCombinacoes;

const numOrigens = CONFIG.origens.length;
const numDestinos = destinosAtuais.length;
const numDatas = gerarDatasIda().length;
console.log(`Combinações: ${todasCombinacoes.length} (${numOrigens} origens x ${numDestinos} destinos x ${numDatas} datas)`);

const extraVerificacao = verificarPreco ? " (+ verificação --verificar)" : "";
console.log(
  modoTeste
    ? `Modo TESTE: ${combinacoes.length} combinações${extraVerificacao}\n`
    : `Monitor FASE 1: ${combinacoes.length} combinações${extraVerificacao}\n`,
);

const erros = [];
const todasOpcoes = [];

let tipoPreco = tipoPrecoFromConfig();
if (verificarPreco) {
  try {
    tipoPreco = await verificarTipoPreco(combinacoes[0]);
    tipoPreco.fonte = "verificacao";
    await sleep(CONFIG.pausaMs);
  } catch (err) {
    console.log(
      `\n  Verificação --verificar não concluída (${err.message}). ` +
        `Usando CONFIG (precoEhTotalDoGrupo=${CONFIG.precoEhTotalDoGrupo}).\n`,
    );
    tipoPreco = tipoPrecoFromConfig();
  }
} else {
  console.log(
    `Preço: usando CONFIG — precoEhTotalDoGrupo=${CONFIG.precoEhTotalDoGrupo}` +
      ` (divide por ${CONFIG.adultos} adultos quando true). Use --verificar para testar na API.\n`,
  );
}

for (let i = 0; i < combinacoes.length; i++) {
  const combo = combinacoes[i];
  const rotulo = `${combo.origem}→${combo.destino} ida ${combo.dataIda}`;
  console.log(`[${i + 1}/${combinacoes.length}] Buscando ${rotulo}...`);

  const query = montarQuery(
    combo,
    criarPassageiros({
      adultos: CONFIG.adultos,
      criancas: CONFIG.criancas,
      bebes: CONFIG.bebes,
    }),
  );

  try {
    const results = await buscarComRetry(query, rotulo);
    falhasSeguidas = 0; // Reset contador de falhas seguidas
    const opcoes = voosParaOpcoes(combo, results, tipoPreco);
    todasOpcoes.push(...opcoes);
    const descartadasNesta =
      results.length - opcoes.length > 0
        ? `, ${results.length - opcoes.length} descartada(s) por preço`
        : "";
    console.log(`  → ${results.length} voos (${opcoes.length} opções válidas${descartadasNesta})`);
  } catch (err) {
    const msg = { combo, erro: `${err.name}: ${err.message}` };
    erros.push(msg);
    console.log(`  → ERRO (seguindo): ${msg.erro}`);
    
    // Interromper se 8 falhas seguidas
    if (falhasSeguidas >= 8) {
      interrompidoPorFalhas = true;
      console.log(`\n⛔ Interrompendo varredura: ${falhasSeguidas} falhas seguidas detectadas.`);
      break;
    }
  }

  if (i < combinacoes.length - 1) {
    await sleep(CONFIG.pausaMs);
  }
}

let sanidade = { suspeitas: 0, corrigidas: 0, confirmadas: 0 };
if (todasOpcoes.length > 0 && !modoTeste) {
  const { opcoes: revalidadas, ...contagens } = await revalidarQuedasSuspeitas(todasOpcoes);
  todasOpcoes.splice(0, todasOpcoes.length, ...revalidadas);
  sanidade = contagens;
}

const tempoTotalSeg = ((Date.now() - inicio) / 1000).toFixed(1);

imprimirTabelaTop10(todasOpcoes);

console.log("\n=== Resumo ===");
console.log(`  Buscas com sucesso: ${buscasOk}`);
console.log(`  Buscas com falha:   ${buscasFalha}`);
console.log(`  Tempo total:        ${tempoTotalSeg}s`);
console.log(`  Opções válidas:     ${todasOpcoes.length}`);
console.log(`  Opções descartadas por preço inválido: ${opcoesDescartadasTotal}`);
console.log(
  `  Quedas suspeitas: ${sanidade.suspeitas} (${sanidade.confirmadas} confirmadas, ${sanidade.corrigidas} corrigidas/descartadas)`,
);
if (interrompidoPorFalhas) {
  console.log(`  ⚠ Varredura interrompida por falhas seguidas`);
}

const payload = {
  config: CONFIG,
  modoTeste,
  verificacaoPreco: tipoPreco,
  estatisticas: {
    buscasOk,
    buscasFalha,
    tempoTotalSegundos: Number(tempoTotalSeg),
    totalOpcoes: todasOpcoes.length,
    opcoesDescartadas: opcoesDescartadasTotal,
    sanidade,
  },
  erros,
  opcoes: todasOpcoes,
};

writeFileSync("resultados.json", JSON.stringify(payload, null, 2), "utf8");
console.log("\nArquivo salvo: resultados.json");

if (salvarSupabase) {
  if (buscasOk < 1) {
    console.log("\nSupabase: não gravado — nenhuma busca deu certo nesta execução.");
  } else if (todasOpcoes.length === 0) {
    console.log("\nSupabase: não gravado — nenhuma opção válida após filtros de preço.");
  } else {
    const { gravadas, falhou } = await gravarPrecosNoSupabase(todasOpcoes);
    if (!falhou) {
      console.log(`\nSupabase: ${gravadas} linha(s) gravada(s) na tabela precos.`);
    } else {
      console.log(`\nSupabase: gravação incompleta — ${gravadas} linha(s) gravada(s) antes do erro.`);
    }
  }
}

// --- Sistema de alertas ---
if (alertar) {
  // Verificar falhas críticas
  if (interrompidoPorFalhas) {
    await enviarEmailFalha("Varredura interrompida por 8 falhas seguidas");
    process.exit(1);
  }
  
  if (buscasOk === 0) {
    await enviarEmailFalha("Nenhuma busca deu sucesso");
    process.exit(1);
  }
  
  // Filtrar viagens abaixo do alvo
  const alertasAnteriores = await buscarAlertasAnteriores(todasOpcoes);
  const viagensParaAlertar = filtrarViagensParaAlertar(todasOpcoes, alertasAnteriores, precoAlvoAtual);
  
  if (viagensParaAlertar.length === 0) {
    console.log("\nNenhuma viagem abaixo do alvo para alertar.");
  } else {
    console.log(`\n=== ${viagensParaAlertar.length} viagem(ns) para alertar ===`);
    const { enviado } = await enviarEmailAlerta(viagensParaAlertar, precoAlvoAtual);
    
    // Só gravar alertas se e-mail foi enviado com sucesso E --alvo NÃO foi usado
    if (enviado && alvoOverride === null) {
      await gravarAlertasNoSupabase(viagensParaAlertar);
    }
  }
}
