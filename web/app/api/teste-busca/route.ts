import { NextRequest, NextResponse } from "next/server";
import { createQuery, Passengers, getFlights } from "fast-flights-ts";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

function contarParadas(segments: any[], destino: string): number {
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

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return NextResponse.json(
      { ok: false, error: "Missing or invalid Authorization header" },
      { status: 401 }
    );
  }

  const token = authHeader.substring(7);

  if (token !== cronSecret) {
    return NextResponse.json(
      { ok: false, error: "Invalid token" },
      { status: 401 }
    );
  }

  const startTime = Date.now();

  try {
    const passageiros = new Passengers({
      adults: 4,
      children: 0,
      infants_on_lap: 0,
    });

    const query = createQuery({
      flights: [
        {
          date: "2026-12-06",
          from_airport: "GRU",
          to_airport: "MCO",
        },
        {
          date: "2026-12-20",
          from_airport: "MCO",
          to_airport: "GRU",
        },
      ],
      seat: "economy",
      trip: "round-trip",
      passengers: passageiros,
      currency: "BRL",
    });

    const results = await getFlights(query);

    const endTime = Date.now();
    const duration = endTime - startTime;

    const top3 = results
      .sort((a, b) => a.price - b.price)
      .slice(0, 3)
      .map((f) => ({
        companhias: f.airlines,
        paradas: contarParadas(f.flights, "MCO"),
        precoTotal: f.price,
        precoPorPessoa: f.price / 4,
      }));

    return NextResponse.json({
      ok: true,
      quantidadeVoos: results.length,
      top3,
      duracaoMs: duration,
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}
