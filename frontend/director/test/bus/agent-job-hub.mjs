import { fixture, result } from './fixture.mjs';
import { contextFixture } from '../verify-studio-agent-protocol.mjs';
import { declarations } from '../../src/commands/motion.js';
import { createStudioCommandJournal } from '../../src/studio-agent-commands.js';

// The route fixtures keep their real held HTTP generation and now expose the
// shared bus, not the retired sidecar candidate protocol. No timer-based waits.
export function agentJobHub(base, bridgeOrigin, readContext = contextFixture) {
  const f = fixture(), initial = readContext();
  const { workspaceId, documentEpoch, sceneId, sceneEpoch } = initial.host;
  f.patch({ host: { workspaceId, documentEpoch, sceneId, sceneEpoch }, revision: initial.revision.scene });
  const journal = createStudioCommandJournal({ host: f.state.host, isRetained: f.ports.isRetained });
  f.ports.journal = () => journal;
  const context = () => ({ ...readContext(), revision: { ...readContext().revision, scene: f.state.revision }, actionIndex: [{ id: 'motion.generate', label: 'Generate motion', generation: 'motion', timeoutMs: 1000 }] });
  const declared = declarations.find(row => row.id === 'motion.generate');
  f.registry.register({ ...declared, available: () => true, async run(args, ctx) {
    const response = await fetch(bridgeOrigin + '/ardy/generate', { method: 'POST', body: JSON.stringify(args), signal: ctx.signal });
    await response.text(); ctx.check(); ctx.commit(() => f.edit(1, 'motion')); return result(['char-alex']);
  } });
  return { ...base, dispose: () => f.bus.dispose(), command: async (name, args) => {
    if (name === 'read_studio_context') return { context: context() };
    if (name === 'inspect_studio') return { context: context(), characters: [{ id: 'char-alex', waypoints: [] }] };
    if (name === 'run_action') return f.bus.run(args.args.action, args.args.args, { ...args, origin: 'agent' });
    return base.command(name, args);
  } };
}
