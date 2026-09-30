import { createQuery, Passengers, getFlights } from "fast-flights-ts";

const departure = new Date();
departure.setDate(departure.getDate() + 45);
const dateStr = departure.toISOString().slice(0, 10);

const query = createQuery({
  flights: [{ date: dateStr, from_airport: "GRU", to_airport: "GIG" }],
  seat: "economy",
  trip: "one-way",
  passengers: new Passengers({ adults: 1 }),
  currency: "BRL",
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

console.log(`Data da viagem: ${dateStr} (GRU → GIG, 1 adulto, econômica, BRL)\n`);

for (let i = 1; i <= 8; i++) {
  try {
    const results = await getFlights(query);
    console.log(`Busca ${i}: ${results.length} voos retornados`);

    if (i === 1) {
      console.log("  Primeiros 5 voos (busca 1):");
      for (let j = 0; j < Math.min(5, results.length); j++) {
        const flight = results[j];
        const airlines = flight.airlines.join(", ");
        console.log(`    ${j + 1}. ${airlines} — R$ ${flight.price}`);
      }
    }
  } catch (err) {
    console.log(`Busca ${i}: ERRO — ${err.name}: ${err.message}`);
  }

  if (i < 8) {
    await sleep(4000);
  }
}
