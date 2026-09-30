import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL?.trim();
const chave = process.env.SUPABASE_SECRET_KEY?.trim();

if (!url || !chave) {
  console.error(
    "Não foi possível consultar o Supabase: faltam SUPABASE_URL e/ou SUPABASE_SECRET_KEY.\n" +
      "Coloque-as no .env e rode: node --env-file=.env ver-historico.mjs",
  );
  process.exit(1);
}

const supabase = createClient(url, chave);

const { count: totalLinhas, error: erroCount } = await supabase
  .from("precos")
  .select("*", { count: "exact", head: true });

if (erroCount) {
  console.error("Erro ao contar linhas no Supabase.");
  console.error(`Mensagem: ${erroCount.message}`);
  process.exit(1);
}

console.log(`\n=== Histórico de preços (Supabase) ===\n`);
console.log(`Total de linhas na tabela precos: ${totalLinhas ?? 0}\n`);

if (!totalLinhas) {
  console.log("Ainda não há registros. Rode o monitor com --salvar para popular a tabela.");
  process.exit(0);
}

const { data: ultimaLinha, error: erroUltima } = await supabase
  .from("precos")
  .select("coletado_em")
  .order("coletado_em", { ascending: false })
  .limit(1)
  .single();

if (erroUltima) {
  console.error("Erro ao buscar a coleta mais recente.");
  console.error(`Mensagem: ${erroUltima.message}`);
  process.exit(1);
}

// Coleta mais recente: linhas gravadas nos últimos 10 minutos até a coleta mais recente
const fimColetaISO = ultimaLinha.coletado_em; // String original do banco (com microssegundos)
const inicioColetaISO = new Date(new Date(fimColetaISO).getTime() - 10 * 60 * 1000).toISOString();

const { data: coletaRecente, error: erroColeta } = await supabase
  .from("precos")
  .select("*")
  .gte("coletado_em", inicioColetaISO)
  .order("preco_por_pessoa", { ascending: true });

if (erroColeta) {
  console.error("Erro ao buscar opções da coleta recente.");
  console.error(`Mensagem: ${erroColeta.message}`);
  process.exit(1);
}

const top10 = (coletaRecente ?? []).slice(0, 10);

console.log(`Coleta mais recente: ${new Date(fimColetaISO).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })} (${coletaRecente?.length ?? 0} opções nessa janela)\n`);
console.log("10 opções mais baratas dessa coleta:\n");
console.log(
  "Orig  Dest  Ida        Volta      Companhia(s)              Paradas  Duração    Total      R$/pessoa",
);
console.log("-".repeat(100));

for (const r of top10) {
  const comps = String(r.companhias ?? "").slice(0, 24).padEnd(24);
  console.log(
    `${r.origem}  ${r.destino}  ${r.data_ida}  ${r.data_volta}  ${comps}  ${String(r.paradas).padStart(7)}  ${String(r.duracao).padStart(9)}  ${String(r.preco_total).padStart(9)}  ${Number(r.preco_por_pessoa).toFixed(0)}`,
  );
}

const { data: menorRegistro, error: erroMenor } = await supabase
  .from("precos")
  .select("preco_por_pessoa, origem, destino, data_ida, data_volta, coletado_em")
  .order("preco_por_pessoa", { ascending: true })
  .limit(1)
  .single();

if (erroMenor) {
  console.error("\nErro ao buscar o menor preço histórico.");
  console.error(`Mensagem: ${erroMenor.message}`);
  process.exit(1);
}

console.log(
  `\nMenor preço por pessoa já registrado: R$ ${Number(menorRegistro.preco_por_pessoa).toFixed(2)} ` +
    `(${menorRegistro.origem}→${menorRegistro.destino}, ida ${menorRegistro.data_ida}, ` +
    `coletado em ${new Date(menorRegistro.coletado_em).toLocaleString("pt-BR")})`,
);
