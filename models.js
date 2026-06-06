import { writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadArenaCatalog } from "./src/catalog.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function run() {
  console.log("Fetching Arena models catalog...");
  try {
    const catalog = await loadArenaCatalog({ refresh: true });
    const modelsJsonPath = join(__dirname, "models.json");
    
    let existingData = { verified: [], discovered: [] };
    try {
      existingData = JSON.parse(readFileSync(modelsJsonPath, "utf8"));
    } catch (e) {
      // ignore
    }
    
    const discovered = catalog.models.map(m => {
      return {
        id: m.id,
        organization: m.owned_by || "arena",
        provider: m.provider,
        publicName: m.publicName,
        name: m.apiModelName,
        displayName: m.displayName,
        capabilities: m.capabilities,
        userSelectable: m.userSelectable,
        catalogStatus: m.catalogStatus,
        discoveredByModelsTest: m.discoveredByModelsTest,
        evidenceArtifact: m.evidenceArtifact
      };
    });
    
    const output = {
      verified: existingData.verified || [],
      discovered: discovered
    };
    
    writeFileSync(modelsJsonPath, JSON.stringify(output, null, 2), "utf8");
    console.log(`Successfully updated ${modelsJsonPath} with ${discovered.length} models.`);
  } catch (error) {
    console.error("Failed to update models.json:", error);
    process.exitCode = 1;
  }
}

run();
