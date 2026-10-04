// AI commands: the Send-to-AI package, the editor's own generate(), which
// reads the mode and image model from the render. A changed choice is set
// first and generate() runs once React has rendered it; a commit already under
// way can predate it, so the wait repeats until the render shows the choice.
import { studioActionDeclaration } from "../studio-actions.js";
import { fail } from "./shared.js";

export const declarations = Object.freeze(["ai.prepareShot"].map(studioActionDeclaration));

export function register(registry, ports) {
	registry.register({ ...studioActionDeclaration("ai.prepareShot"), available: () => true,
		run: async ({ mode, model }, context) => {
			const current = ports.state().aiShot, wanted = { mode: mode ?? current.mode, imageModel: model ?? current.imageModel };
			if (model && wanted.mode !== "image") fail("INVALID_ARGUMENT", `model picks an image model, but this would be a ${wanted.mode} prompt; omit model or pass mode "image".`);
			const rendered = () => { const { aiShot } = ports.state(); return aiShot.mode === wanted.mode && aiShot.imageModel === wanted.imageModel; };
			if (!rendered()) {
				ports.setAiShotMode(wanted.mode);
				ports.setAiImageModel(wanted.imageModel);
				for (let commits = 0; !rendered(); commits++) {
					if (commits === 3) fail("TARGET_NOT_READY", "The Studio did not render the new mode and model; run the action again.");
					await ports.afterRender();
				}
			}
			context?.check();
			const result = ports.generate();
			const shot = result.shot && { id: result.shot.id, name: result.shot.name, range: { startFrame: result.shot.startFrame, endFrameExclusive: result.shot.endFrame + 1 } };
			const referenceFrames = (result.frame ? 1 : 0) + (result.frameB ? 1 : 0);
			return { affectedIds: [], output: { prompt: result.prompt, mode: result.mode, modelLabel: result.modelLabel ?? null, shot, aspectRatio: result.aspectRatio, cameraMode: result.camera?.mode ?? null, referenceFrames },
				summary: `Prepared the ${result.mode} prompt${result.modelLabel ? ` for ${result.modelLabel}` : ""} for ${shot ? `${shot.name} [${shot.range.startFrame}, ${shot.range.endFrameExclusive})` : "the current camera"}; the Studio's result panel shows it with ${referenceFrames} reference frame${referenceFrames === 1 ? "" : "s"} for the user to copy and download.` };
		} });
}
