import { acquireDependencies } from "./dependency-acquisition.js";
import { deriveDependencyInputs } from "./dependency-inputs.js";
import { publishDependencySnapshot } from "./dependency-snapshot.js";
import { deriveWorkspaceArtifact, planWorkspaceDerivations } from "./derived-artifact.js";
import { ReviewLspError } from "./errors.js";
import { buildProjection } from "./projection.js";
import type {
  CandidateDescriptor,
  DependencySnapshotDescriptor,
  DerivedWorkspaceArtifactDescriptor,
  ProjectionDescriptor,
} from "./types.js";

export interface PreparedSemanticEnvironment {
  snapshot: DependencySnapshotDescriptor | null;
  projection: ProjectionDescriptor | null;
  derived_artifacts: DerivedWorkspaceArtifactDescriptor[];
}

/**
 * Builds the strongest offline semantic environment already supported by the candidate state.
 *
 * Acquisition remains explicit elsewhere. This path never contacts the network: if the
 * candidate's dependency inputs are not already available, semantic queries honestly fall back
 * to the source-only compatibility profile instead of mutating dependency state implicitly.
 */
export async function prepareSemanticEnvironment(input: {
  candidate: CandidateDescriptor;
  stateDirectory: string;
}): Promise<PreparedSemanticEnvironment> {
  const { candidate, stateDirectory } = input;
  if (!candidate.entries.some((entry) => entry.path === "pnpm-lock.yaml" && entry.kind === "file")) {
    return { snapshot: null, projection: null, derived_artifacts: [] };
  }

  const inputs = await deriveDependencyInputs(candidate);
  const acquisition = await acquireDependencies({
    candidate,
    inputs,
    stateDirectory,
    networkPolicy: "OFFLINE",
  });
  if (acquisition.state !== "SATISFIED") {
    return { snapshot: null, projection: null, derived_artifacts: [] };
  }

  const snapshot = await publishDependencySnapshot({
    candidate,
    inputs,
    stateDirectory,
  });
  let projection = await buildProjection({
    candidate,
    snapshot,
    stateDirectory,
    workspaceManifests: inputs.workspace_manifests,
  });
  const derivedArtifacts: DerivedWorkspaceArtifactDescriptor[] = [];

  if (projection.entry_point_gate.state === "INCOMPLETE") {
    let order: string[] = [];
    try {
      order = await planWorkspaceDerivations({
        candidate,
        workspaceManifests: inputs.workspace_manifests,
        gate: projection.entry_point_gate,
      });
    } catch (error) {
      if (!(error instanceof ReviewLspError) || error.code !== "DERIVED_ARTIFACT_UNSUPPORTED") throw error;
    }

    for (const manifestPath of order) {
      try {
        const artifact = await deriveWorkspaceArtifact({
          candidate,
          snapshot,
          projection,
          manifestPath,
          stateDirectory,
        });
        if (!artifact.strong_admission) continue;
        derivedArtifacts.push(artifact);
        projection = await buildProjection({
          candidate,
          snapshot,
          stateDirectory,
          derivedArtifacts,
          workspaceManifests: inputs.workspace_manifests,
        });
      } catch (error) {
        if (!(error instanceof ReviewLspError)) throw error;
        if (error.code === "DERIVED_ARTIFACT_UNSUPPORTED" || error.code === "DERIVED_ARTIFACT_FAILED") continue;
        throw error;
      }
    }
  }

  return { snapshot, projection, derived_artifacts: derivedArtifacts };
}
