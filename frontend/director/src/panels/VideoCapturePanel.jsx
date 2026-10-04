import Foldout from "./Foldout.jsx";
import ExtensionsNotice from "./ExtensionsNotice.jsx";
import { ko } from "../locale.js";

export default function VideoCapturePanel({ isCharacterSelection }) {
	return <Foldout hidden={!isCharacterSelection} defaultOpen={false} title={ko("Motion extensions", "모션 확장")}>
		<ExtensionsNotice />
	</Foldout>;
}
