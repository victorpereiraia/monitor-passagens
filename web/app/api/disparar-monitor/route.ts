import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const REPO = "victorpereiraia/monitor-passagens";
const WORKFLOW = "monitor-diario.yml";

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const githubToken = process.env.GITHUB_DISPATCH_TOKEN;
  if (!githubToken) {
    return NextResponse.json(
      { ok: false, error: "GITHUB_DISPATCH_TOKEN ausente" },
      { status: 500 }
    );
  }

  const resposta = await fetch(
    `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ ref: "main" }),
    }
  );

  if (!resposta.ok) {
    const detalhe = await resposta.text();
    console.error("Falha ao disparar workflow", resposta.status, detalhe);
    return NextResponse.json(
      { ok: false, status: resposta.status, error: detalhe },
      { status: 502 }
    );
  }

  return NextResponse.json({ ok: true });
}
