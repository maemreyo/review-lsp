import { prepareCandidate } from "../../dist/src/index.js";

const [repo, commit, stateDirectory] = process.argv.slice(2);
if (!repo || !commit || !stateDirectory) {
  throw new Error("usage: candidate-prepare-crash-child.mjs <repo> <commit> <state>");
}

await prepareCandidate({ repo, commit, stateDirectory });
process.stdout.write("DONE\n");
