// SPDX-License-Identifier: AGPL-3.0-or-later
export function beginProposalPreview(context, commands) {
  return context.bus.beginPreview(commands);
}
