import { loadArenaCatalog, toOpenAIModel } from "./catalog.js";

const command = process.argv[2];

if (command === "pull-models") {
  const catalog = await loadArenaCatalog({ refresh: true });
  console.log(
    JSON.stringify(
      {
        fetched_at: catalog.fetchedAt,
        deploy_ids: catalog.deployIds,
        counts: catalog.counts,
        hidden: catalog.hiddenCallable.map(toOpenAIModel),
      },
      null,
      2,
    ),
  );
} else {
  console.error("Usage: node src/cli.js pull-models");
  process.exitCode = 2;
}
