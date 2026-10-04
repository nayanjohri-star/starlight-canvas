// SPDX-License-Identifier: AGPL-3.0-or-later
// Preserve the upstream factory and its MIT attribution. This build transform
// removes only its retry against a public CDN when local font data fails.
const retry = '.catch((function(n){if(l!==v)return j||(console.error(\'unicode-font-resolver: Failed loading from dataUrl "\'+l+\'", trying default CDN. \'+n.message),j=!0),l=v,p.delete(t),M(t);throw n}))';
export function localOnlyFontResolver(source) {
  if (source.split(retry).length !== 2) throw new Error('The reviewed Troika font resolver retry changed; review its local-only transform');
  return source.replace(retry, '.catch((function(n){throw n}))');
}
