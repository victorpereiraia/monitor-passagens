import { Resend } from "resend";

const apiKey = process.env.RESEND_API_KEY?.trim();
const destino = process.env.EMAIL_DESTINO?.trim();

if (!apiKey) {
  console.error(
    "Não deu para enviar: falta a variável RESEND_API_KEY no ambiente.\n" +
      "Coloque sua chave no arquivo .env e rode:\n" +
      "  node --env-file=.env enviar-teste.mjs",
  );
  process.exit(1);
}

if (!destino) {
  console.error(
    "Não deu para enviar: falta a variável EMAIL_DESTINO no ambiente.\n" +
      "Defina o e-mail de destino no .env.",
  );
  process.exit(1);
}

const resend = new Resend(apiKey);

const { data, error } = await resend.emails.send({
  from: "Monitor de Passagens <onboarding@resend.dev>",
  to: destino,
  subject: "Teste do monitor de passagens ✈️",
  text:
    "Olá!\n\n" +
    "Este é um e-mail de teste do monitor de passagens. Se você está lendo isto, " +
    "a integração com o Resend funcionou corretamente.\n\n" +
    "Bons voos!",
});

if (error) {
  console.error("O Resend recusou ou não conseguiu enviar o e-mail.\n");
  console.error(`Detalhe técnico: ${error.name} — ${error.message}`);
  if (error.statusCode != null) {
    console.error(`Código HTTP: ${error.statusCode}`);
  }
  console.error(
    "\nDicas comuns: chave API inválida ou vazia; destino não permitido na conta " +
      "de teste (onboarding@resend.dev só envia para o e-mail cadastrado no Resend); " +
      "cota ou limite de envio.",
  );
  process.exit(1);
}

console.log(`E-mail enviado com sucesso para ${destino}.`);
console.log(`ID no Resend: ${data.id}`);
