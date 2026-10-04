// SPDX-License-Identifier: AGPL-3.0-or-later
// The measuring deck keeps its texture in working views. Shot monitors and
// captures borrow an unmarked material, then restore the exact editor state.
export function withCleanSceneMaterials(scene, render) {
  const borrowed = [];
  scene.traverse(node => {
    const clean = node.userData?.cleanExportMaterial;
    if (clean && node.material !== clean) {
      borrowed.push([node, node.material]);
      node.material = clean;
    }
  });
  try { return render(); }
  finally { for (const [node, material] of borrowed) node.material = material; }
}
