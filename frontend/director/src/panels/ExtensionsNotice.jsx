import { ko } from "../locale.js";

/** Hosted generation is owned by the canvas draft toolbar, not upstream
 * GPU/fal/OAuth clients. This informational surface has no network action. */
export default function ExtensionsNotice({ compact = false }) {
	return <section className={"hosted-extension-notice" + (compact ? " compact" : "")} data-testid="hosted-extensions" aria-label={ko("Motion extensions", "모션 확장")}>
		{!compact && <p>{ko("Local GPU motion extraction, Kimodo/ProjFlow, direct fal generation and local OAuth agents are optional upstream extensions. They are not connected on this site.", "로컬 GPU 모션 추출, Kimodo/ProjFlow, fal 직접 생성 및 로컬 OAuth 에이전트는 이 사이트에 연결되지 않은 선택 확장입니다.")}</p>}
		<p>{ko("This hosted director exports references. Start model generation explicitly in the canvas draft and review its model, parameters and expected cost there.", "이 편집기는 참조 자료를 내보냅니다. 캔버스 초안에서 모델, 매개변수 및 예상 비용을 확인한 뒤 직접 생성을 시작하세요.")}</p>
	</section>;
}
