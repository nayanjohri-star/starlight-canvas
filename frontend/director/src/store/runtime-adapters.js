// Authored shape: domain.characters[id] = { ikKeys: { [frame]: { [track]:
// { q?, p?, baseQ?, basePos?, chainP?, keepTranslations? } } }, pose: {
// [bone]: { q?, p?, scale? } }, attachments: { [objectId]: { bone?, q?, p?,
// scale? } } }. All values are plain data. Maps, bones and mesh parents stay
// exclusively in this runtime adapter. No domain is migrated by importing it.
import { Quaternion, Vector3 } from 'three';

const vector = value => new Vector3(value.x, value.y, value.z);
const quaternion = value => new Quaternion(value.x, value.y, value.z, value.w).normalize();
function runtimeKey(key) {
  return {
    q: key.q?.map(quaternion) ?? null, p: key.p ? vector(key.p) : null,
    ...(key.baseQ ? { baseQ: key.baseQ.map(quaternion) } : {}),
    ...(key.basePos ? { basePos: vector(key.basePos) } : {}),
    ...(key.chainP ? { chainP: key.chainP.map(vector) } : {}),
    ...(key.keepTranslations ? { keepTranslations: true } : {}),
  };
}
const transform = object => ({ p: object.position.clone(), q: object.quaternion.clone(), scale: object.scale.clone() });
function applyTransform(object, pose) {
  if (pose.p) object.position.copy(pose.p);
  if (pose.q) object.quaternion.copy(pose.q).normalize();
  if (pose.scale) object.scale.copy(pose.scale);
  object.updateMatrixWorld(true);
}

// resolveRig returns { root, bones: Map<id,Object3D>, ikState: {keys,tracked} }
// or null while unloaded. Call sync after loading/replacing a rig. All writer
// methods deliberately use store.write, so they inherit the bus write guard.
export function createRigRuntimeAdapter({ store, domain = 'motion', characterId, resolveRig, resolveObject }) {
  let currentRoot = null, lastIntent = null;
  const poses = new Map(), attachments = new Map();
  const intent = () => store.read(domain).characters[characterId];
  function sync() {
    const authored = intent(), rig = resolveRig();
    if (!rig) { lastIntent = null; return; }
    if (rig.root !== currentRoot) {
      for (const [object, before] of attachments) { before.parent?.add(object); applyTransform(object, before); }
      currentRoot = rig.root; poses.clear(); attachments.clear();
    }
    lastIntent = authored;
    // Preserve the public Map/Set identities used by live IK code, but never
    // put references to frozen intent (or caller input) into either container.
    rig.ikState.keys.clear(); rig.ikState.tracked.clear();
    for (const [frame, tracks] of Object.entries(authored?.ikKeys ?? {})) {
      const entry = new Map();
      for (const [track, key] of Object.entries(tracks)) {
        entry.set(track, runtimeKey(key)); rig.ikState.tracked.add(track);
      }
      rig.ikState.keys.set(Number(frame), entry);
    }
    const pose = authored?.pose ?? {};
    for (const [id, before] of poses) {
      if (!Object.hasOwn(pose, id)) { applyTransform(rig.bones.get(id), before); poses.delete(id); }
    }
    for (const [id, value] of Object.entries(pose)) {
      const bone = rig.bones.get(id);
      if (!poses.has(id)) poses.set(id, transform(bone));
      applyTransform(bone, value);
    }
    const wanted = new Set();
    for (const [id, value] of Object.entries(authored?.attachments ?? {})) {
      const object = resolveObject(id);
      wanted.add(object);
      if (!attachments.has(object)) attachments.set(object, { parent: object.parent, ...transform(object) });
      (value.bone ? rig.bones.get(value.bone) : rig.root).add(object);
      applyTransform(object, value);
    }
    for (const [object, before] of attachments) {
      if (wanted.has(object)) continue;
      if (before.parent) before.parent.add(object); else object.removeFromParent();
      applyTransform(object, before); attachments.delete(object);
    }
  }
  const release = store.subscribe(() => { if (intent() !== lastIntent) sync(); });
  sync();
  const update = fn => store.write(domain, slice => ({ ...slice, characters: { ...slice.characters, [characterId]: fn(slice.characters[characterId]) } }));
  return {
    sync, dispose: release,
    setIkKey(frame, tracks) {
      return update(current => ({ ...current, ikKeys: { ...current.ikKeys, [frame]: { ...current.ikKeys[frame], ...tracks } } }));
    },
    removeIkKey(frame) {
      return update(current => {
        const ikKeys = { ...current.ikKeys }; delete ikKeys[frame];
        return { ...current, ikKeys };
      });
    },
    setPose: pose => update(current => ({ ...current, pose })),
    setAttachments: attachments => update(current => ({ ...current, attachments })),
  };
}
