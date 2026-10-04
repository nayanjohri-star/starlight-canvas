// SPDX-License-Identifier: AGPL-3.0-or-later
import { ko } from './locale.js';

export default function ScenePerformanceNotice({ status, location }) {
  if (!status?.beyondTested) return null;
  return <p className="inspector-hint" role="status" aria-live="polite" data-testid={`scene-performance-${location}`}
    data-visible-characters={status.visibleCharacters} data-visible-props={status.visibleProps}>
    {ko('Outside the tested scene range. Performance of complex models and large textures has not been verified.',
      '실측한 장면 범위를 넘었습니다. 복잡한 모델과 큰 텍스처의 성능은 검증되지 않았습니다.',
      '超过当前实测场景，复杂模型与大贴图性能未验证。')}
    <br /><small>{ko('Tested baseline: 2 default characters and 20 basic props, without custom models or image textures.',
      '실측 기준: 기본 인물 2명과 기본 소품 20개. 사용자 모델과 이미지 텍스처는 포함하지 않았습니다.',
      '已测基准：2个默认人物、20个基础道具，不含自定义模型或图片贴图。')}</small>
  </p>;
}
