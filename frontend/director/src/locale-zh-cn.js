// Render-time translations for upstream UI literals. This table is deliberately
// separate from scene data: importing it cannot rewrite names or prompts.
export const ZH_CN = Object.freeze(Object.fromEntries(`
 pts| 个点
 · click to cycle| · 点击切换
(none)|（无）
(unreadable image)|（图片无法读取）
+ Add shot|+ 添加镜头
+ New scene|+ 新建场景
1. Select the shot|1. 选择镜头
2. Draw rail, then drag across the top view|2. 绘制轨道，在俯视图中拖动
2D Root|平面根运动
A GLB, OBJ or FBX model standing in the set|将 GLB、OBJ 或 FBX 模型放入场景
A generation is already running|已有生成任务正在运行
A new version of CozyClay is ready.|导演台有新版本可用。
A newer edit comes after this deletion. Use Undo history instead.|删除之后已有新修改，请通过撤销历史恢复。
A photo of the real thing, standing in the set as a card|将真实物体的照片作为平面卡片放入场景
Action|动作
Add a 2 second shot without changing existing shots|添加 2 秒镜头，保留现有镜头
Add a 2–4 second prompt clip — one action per block|添加 2–4 秒提示词片段，每个块描述一个动作
Add a prompt block and describe its motion first|请先添加提示词块并描述动作
Add a shot first — a pack describes one cut|请先添加镜头，参考包对应一个镜头
Add a shot first — a storyboard is one row per shot|请先添加镜头，故事板每行对应一个镜头
Add a shot to export OTIO|添加镜头后可导出 OTIO
Add a shot to export video or OTIO|添加镜头后可导出视频或 OTIO
Add at least one Shot before exporting OTIO|导出 OTIO 前请至少添加一个镜头
Add at least one Shot before exporting a keyframe pack|导出参考包前请至少添加一个镜头
Add at least one Shot before exporting a storyboard|导出故事板前请至少添加一个镜头
Add object|添加对象
Add object to the set|向场景添加对象
Add second subject|添加第二个角色
Advanced|高级
Agent|扩展说明
Agent panel|扩展说明面板
Aim ahead of subject travel|朝向角色前进方向
All|全部
Alt + left-drag to circle|按住 Alt 并左键拖动以环绕
An export is already running|已有导出正在进行
Animation|时间轴
Animation timeline|动画时间轴
Anonymous analytics|匿名使用统计
Apply pose|应用姿态
Arms crossed|双臂交叉
Assets|素材
At least one scene is required|至少保留一个场景
Attached to|附着到
Auto Color|自动配色
Auto-detect background|自动识别背景
Back to assets|返回素材
Back to constant speed — clears the curve and every cut|恢复匀速，清除曲线和所有切点
Back to the default pose|已恢复默认姿态
Background editor — drag over the background to cut it out|背景编辑器：拖动标记要移除的背景
Basic|基础
Blocking|场景预演
Body contact|身体接触
Body contact off — floor constraints are disabled|身体接触已关闭，地面约束已禁用
Body contact on — body markers stay above the floor|身体接触已开启，身体控制点保持在地面上方
Body contact — keep hands, knees, feet, head, and hips above the floor|身体接触：让手、膝盖、脚、头和髋部保持在地面上方
Body part colours|身体部位配色
Bottom window|底部面板
Brightness|亮度
Bring back|恢复区域
Brush|画笔
Brush size|画笔大小
CAMERA|摄影机
CHECK|检查
Cam|摄影机
Camera|摄影机
Camera preset|摄影机预设
Camera preview|摄影机预览
Camera tutorial|摄影机教程
Cancel|取消
Cancel export|取消导出
Cancel run|取消运行
Cancel stops at the next frame boundary, before download.|取消会在下一帧边界停止，并阻止下载。
Cancelled|已取消
Cancelling at the current work boundary…|正在安全停止当前步骤…
Cap dolly travel speed|限制移动速度
Card height (m)|卡片高度（米）
Card width (m)|卡片宽度（米）
Change folder…|更换文件夹…
Character|角色
Character 1|角色 1
Character 2|角色 2
Character color|角色颜色
Character rig|角色骨架
Characters|角色
Checking for the dev bridge…|正在检查开发桥接服务…
Choose Project|选择工程
Choose a character and move it on the stage.|选择角色，并在场景中移动。
Choose a reference picture|选择参考图片
Choose folder…|选择文件夹…
Choose image|选择图片
Choose project|选择工程
Choose video|选择视频
Clay|黏土材质
Clear|清除
Clear loaded motion|清除已加载动作
Clear motion|清除动作
Clear motion and apply pose|清除动作并应用姿态
Clear motion and restore the blocking pose|清除动作并恢复预演姿态
Clear the selection|清除选择
Cleared the current motion and applied the pose|已清除当前动作并应用姿态
Click again to permanently delete this scene|再次点击以永久删除此场景
Click at a frame to store the current camera framing|点击时间轴帧以记录当前摄影机构图
Click here|点击这里
Click or ▸ to expand · drag to move|点击或按 ▸ 展开，拖动移动
Click or ▾ to fold · drag to move|点击或按 ▾ 收起，拖动移动
Click the set floor in the Shot view to add waypoints|点击镜头视图中的地面以添加路径点
Click the set floor in the Shot view to drop waypoints|点击镜头视图中的地面以放置路径点
Click to fly the shot camera|点击控制镜头摄影机
Close|关闭
Close pose studio|关闭姿态编辑器
Close tutorial|关闭教程
Collapse inset view|收起小视图
Collapse timeline|收起时间轴
Colour hex|颜色十六进制值
Completed|已完成
Composing the storyboard…|正在制作故事板…
Confirm delete|确认删除
Contact sheet of every shot with its prompt|包含所有镜头及其提示词的故事板
Continue editing|继续编辑
Contrapposto|重心偏移站姿
Core loop complete|基础流程已完成
Couldn't find the selected pose — pick again|找不到所选姿态，请重新选择
Crane height — drag a point, click empty time to add one|升降高度：拖动控制点，点击空白时间添加控制点
Crane points on this rail — click the Shot block's key strip to add one|轨道升降点：点击镜头块的关键帧区域添加
Create|创建
Create a project|创建工程
Create your first shot|创建第一个镜头
Crouch|蹲下
Custom colour|自定义颜色
Cut|切点
Cut at playhead|在播放头处切分
Cut for|目标模型
Cut out|移除区域
Cut the Full-Body clip at the playhead|在播放头处切分全身动作
Cycle composition guides|切换构图辅助线
Damping|缓动
Decoding…|正在解码…
Delete|删除
Delete or Backspace to remove|按 Delete 或 Backspace 删除
Delete path|删除路径
Delete rail|删除轨道
Delete shot and leave free-camera time|删除镜头并保留自由摄影机时间
Delete this Shot's rail geometry and return to Follow|删除此镜头的轨道并恢复跟随
Delete this route; the object stands still again|删除此路径，让对象停止移动
Deleting…|正在删除…
Depth (mp4)|深度视频（MP4）
Depth + normal passes|深度与法线图
Depth and normal conditioning plates of the current framing|导出当前构图的深度与法线参考图
Depth and normal passes downloaded|深度与法线图已下载
Depth pass of the whole shot as an mp4 for video-model conditioning|将整个镜头的深度图导出为视频参考
Depth range sampled|已采样深度范围
Detach|解除附着
Dismiss|关闭提示
Dismiss guide|关闭引导
Distance|距离
Distinct display colors per object — captures include them while on|为每个对象显示不同颜色，开启时导出也包含这些颜色
Dolly|推拉
Dolly on rail|沿轨道移动
Dolly speed — drag the line; cuts and reset live in the camera bar above|移动速度：拖动曲线，在上方摄影机栏切分或重置
Done|完成
Download OTIO cut list|下载 OTIO 剪辑列表
Downloading…|正在下载…
Drag a line here|在此处绘制曲线
Drag the path|拖动路径
Drag the sun in the scene to move the light. Shadows and warmth follow it.|拖动场景中的太阳图标移动光源，阴影和光线方向会随之改变。
Drag the trajectory line in the viewport first|请先在视口中拖动轨迹线
Drag to move · edge handles resize · right-click removes|拖动移动，边缘手柄调整大小，右键删除
Drag — wider is slower, narrower is faster|拖动调整：越宽越慢，越窄越快
Draw a route on the Top-View map to make this prop travel.|在俯视图上绘制路径，让道具沿路径移动。
Draw crane height in the Shot box|在镜头块中绘制升降高度
Draw dolly speed in the Shot box|在镜头块中绘制推拉速度
Draw path|绘制路径
Draw rail|绘制轨道
Draw this Camera Block's rail in the Top-View|在俯视图中绘制此摄影机块的轨道
Drawing…|正在绘制…
Duplicate|复制
Duplicate shot|复制镜头
Edge feather|边缘羽化
Edge shrink|边缘收缩
Edit rig with IK|用 IK 编辑骨架
Edit timing and movement|编辑时间与运动
Enable or disable 2D Root path constraints (P)|开启或关闭平面根路径约束（P）
Encoding|编码中
Encoding the requested frames, not yet a completed file.|正在编码指定帧，文件尚未完成。
Engine…|引擎…
Environment|环境
Environment description|环境描述
Environment reference|环境参考图
Environment reference set|已设置环境参考图
Esc · exit|Esc · 退出
Exit line editing (Esc)|退出路径编辑（Esc）
Expand inset view|展开小视图
Expand timeline|展开时间轴
Export|导出
Export cancelled. No further downloads will be requested.|已取消导出，不会继续下载。
Export pipeline completed. The requesting tool handles the file handoff.|导出流程已完成，文件由请求方接收。
Exports: keyframe pack, video, passes, storyboard, cut list|导出参考包、视频、渲染图、故事板或剪辑列表
Extract again|重新提取
Extract motion|提取动作
Extracting…|正在提取…
FETCHING|获取中
Faces travel|朝向移动方向
Failed|失败
Finalizing|正在完成
Finish rig editing|结束骨架编辑
Finishing encoder output. Progress is indeterminate.|正在封装编码结果，暂时无法计算进度。
First shot steps|第一个镜头的步骤
Fix body collisions (this frame)|修正身体穿插（当前帧）
Fix body collisions (whole clip)|修正身体穿插（整个片段）
Fixed facing|固定朝向
Flat|纯色
Floor|地面
Focus|焦点
Folder access is not granted — choose it again.|未获得文件夹访问权限，请重新选择。
Folder access needs to be re-allowed.|需要重新允许访问文件夹。
Follow Off|关闭跟随
Follow On|开启跟随
Follow cam|跟随摄影机
Follow these four actions to see a result quickly.|按这四个步骤快速完成第一个镜头。
Foot lock|锁定脚部
Foot snap|脚部固定
Foot snap off — the feet follow the body|脚部固定已关闭，脚部跟随身体
Foot snap on — the feet stay planted while the body moves|脚部固定已开启，移动身体时脚部保持原位
Footage → motion|视频转动作
Frame|帧
Frame download requested. Check your browser's downloads.|已请求下载图像，请检查浏览器下载记录。
Frame range|帧范围
Frame the shot|设置镜头构图
Frames submitted to encoder|已提交编码的帧数
Free|自由
From photo|从照片提取
Full-Body|全身
GENERATING|生成中
GVHMR extraction is unavailable until the local GPU bridge is connected.|GVHMR 是本地 GPU 扩展，本站未接入。
GVHMR extraction runs on the GPU box (about a minute per 15 s of footage).|GVHMR 提取属于 GPU 扩展，本站未接入。
Generate the line edit|生成路径编辑结果
Generating motion…|正在生成动作…
Gesture|手势
Graphics restored.|3D 图形上下文已恢复。
Grid snapping — hold Ctrl during a drag to invert|网格吸附：拖动时按住 Ctrl 临时切换
Handing off existing PNGs. Synchronous downloads cannot be cancelled.|正在交付现有 PNG，同步下载无法中途取消。
Hands on hips|双手叉腰
Hands up|双手举起
Head start|提前量
Height|高度
Height (m)|高度（米）
Help|帮助
Hide|隐藏
Hierarchy|对象树
Hold right, press keys|按住右键并按移动键
How many frames a pull carries along the path|拖动路径时影响的帧数
I have an environment sheet|使用环境参考图
IDLE|空闲
IK ON|IK 已开启
IK 파츠 편집|IK 部位编辑
Identity image|角色参考图
Identity image set|已设置角色参考图
Identity reference|角色参考图
Image|图片
Image deleted. This session can undo it.|已删除图片，本次会话内可撤销。
Import 3D object|导入 3D 对象
Import image as cutout|导入图片卡片
In use|使用中
Influence|影响范围
Inspector|属性
Inverse kinematics|逆向运动学（IK）
Joint|关节
Joint whose path is edited|要编辑路径的关节
Jump|跳跃
Keep going|继续前进
Keep going in the last direction after the route ends|路径结束后继续沿最后方向前进
Keep the camera at the captured distance from the subject|保持摄影机与角色的捕获距离
Keep the current take|保留当前动作
Key pose as IK correction|将姿态记录为 IK 修正关键帧
Keyframe pack (zip)|镜头参考包（ZIP）
Kimodo — block it, redo it, extend it|Kimodo 扩展：生成、重做与延长动作
Kneel|跪姿
Language|语言
Language and analytics|语言与使用统计
Later|稍后
Learn the camera in seven steps|用七个步骤学习摄影机操作
Light|光源
Line editing|路径编辑
Line editing off|已关闭路径编辑
Live workspace|实时工作空间
Load a rig to edit poses|加载骨架后可编辑姿态
Loaded take|已加载动作
Loading details…|正在加载详情…
Local video file|本地视频文件
Locked-off footage with both performers in frame is best.|建议使用固定机位且两名角色均在画面内的视频。
Look|视角
Look / style|视觉风格
Look through|摄影机视图
Look through the shot camera|查看镜头摄影机视图
Look-ahead|前视距离
Looking back|回头
Loop|循环
Manage storage|管理存储
Matte|抠图
Metres per second; 0 spreads the route across the whole take|单位为米/秒，0 表示在整个动作时长内完成路径
Model|模型
Motion|动作
Motion controls|动作控制
Motion generation|动作生成扩展
Motion generation complete|动作生成已完成
Motion mode · edit the timeline below|动作模式 · 在下方时间轴中编辑
Move|移动
Move keys|移动关键帧
Move tool (W)|移动工具（W）
Multi-Model video URL|多角色视频地址
My images|我的图片
My models|我的模型
My poses|我的姿态
Name|名称
Nearest|最近邻
New Project|新建工程
Next frame|下一帧
Next frame (j)|下一帧（J）
No .cclayproject files in this folder.|此文件夹中没有导演工程文件。
No file selected|未选择文件
No projects yet — save one and it shows up here.|暂无工程，保存后会显示在这里。
No shots yet — use + Add shot in the lane header to create one.|暂无镜头，请点击轨道标题中的“+ 添加镜头”。
No stored image assets are used by a scene.|当前场景未使用任何已存储图片。
No stored image assets.|暂无已存储图片。
No unused image assets. Every stored image is still used by a scene.|所有已存储图片都仍被场景使用。
None|无
Not saved|尚未保存
Nothing is marked yet|尚未标记区域
OFF|关
ON|开
OTIO cut list|OTIO 剪辑列表
Object actions|对象操作
Object colour|对象颜色
Object deleted.|已删除对象。
Objects|对象
Off|关闭
Open Export|打开导出
Open Project…|打开工程…
Open Workflow|打开画布
Open a project|打开工程
Open file…|打开文件…
Orbit|环绕
Output aspect ratio|输出画幅
PLAYBACK|播放
PROBING|检查中
PROP|道具
Panels|面板
Parent|父级对象
Paste|粘贴
Path editing on|路径编辑已开启
Pause playback|暂停播放
Pin a moment|固定当前姿态
Pinning moments|正在固定姿态
Pins cleared — one edit is one gesture, and this one is now the path|已清除固定点，本次编辑改为路径编辑
Pitch|俯仰
Place|放置
Place subjects and props|放置角色与道具
Placement|位置
Play|播放
Play / pause (Space)|播放 / 暂停（空格）
Play playback|开始播放
Playback transport|播放控制
Point added — drag it here, or lift it in the scene|已添加控制点，可在此处拖动或在场景中调整高度
Point height|控制点高度
Pointing|指向
Pose|姿态
Pose applied|已应用姿态
Pose categories|姿态分类
Pose correction tools|姿态修正工具
Position|位置
Prepare a source inside the Motion workspace.|请在动作面板中准备输入素材。
Preparing|准备中
Preparing the renderer and checking MP4 support…|正在准备渲染器并检查 MP4 支持…
Press play to see the scene come alive.|点击播放预览场景。
Preview|预览
Previewing the pull…|正在预览路径调整…
Previous frame|上一帧
Previous frame (k)|上一帧（K）
Privacy|隐私
ProjFlow — grab the joint's path and pull|ProjFlow 扩展：拖动关节轨迹
Project|工程
Project access was not granted.|未获得工程访问权限。
Project actions|工程操作
Project name|工程名称
Projects|工程
Projects folder|工程文件夹
Prompt Blocks|提示词块
Prompt copied to clipboard|提示词已复制
Prompts|提示词
Props|道具
Pull the path on the viewport first|请先在视口中拖动路径
Put it back in the set, where it is now|保留当前位置并解除附着
READY|就绪
ROOT PATH|根路径
Rail|轨道
Ratio|画幅
Re-allow|重新授权
Read automatically from the camera position|根据摄影机位置自动计算
Read automatically from the camera tilt|根据摄影机倾角自动计算
Read the pose out of a reference photograph|从参考照片提取姿态
Reading…|正在读取…
Ready|就绪
Recent projects|最近工程
Recenter on subject|以角色为中心
Redo|重做
Redone|已重做
Redraw path|重绘路径
Redraw rail|重绘轨道
Reference grid|参考网格
Refine|细化
Refresh|刷新
Regenerate from trail edit|按轨迹调整重新生成
Relaxed|放松站姿
Reload|重新载入
Reload to update|重新载入以更新
Remove from list|从列表移除
Remove point|删除控制点
Remove subject|移除角色
Remove the selected interior crane point|删除选中的内部升降控制点
Removing…|正在移除…
Rename|重命名
Replace|替换
Reset curve|重置曲线
Reset light|重置光源
Reset pose|重置姿态
Reset the curve|重置曲线
Resize frame monitor|调整时间轴高度
Resize hierarchy and inspector panel|调整属性面板宽度
Resize hierarchy panel|调整对象树宽度
Resize inset view|调整小视图大小
Resize prompt end|调整提示词结束帧
Resize prompt start|调整提示词开始帧
Restore|恢复
Retime segment by stretch|拉伸片段以调整时长
Retry same export|重试此导出
Return to the editor view (Esc)|返回编辑视图（Esc）
Rig|骨架
Rig Control|骨架控制
Right-drag in the viewport to look around.|在视口中按住右键拖动以转动视角。
Right-drag to look|右键拖动转动视角
Root path mode|根路径模式
Rotate|旋转
Rotate tool (E)|旋转工具（E）
Rotation|旋转
Run|奔跑
SUBJECT OUT OF FRAME|角色位于画面外
Save|保存
Save Project|保存工程
Save Project As…|工程另存为…
Save current pose|保存当前姿态
Save failed|保存失败
Save pose|保存姿态
Save the character's current pose|保存角色当前姿态
Saved|已保存
Saving…|保存中…
Scale|缩放
Scale tool (R)|缩放工具（R）
Scene|场景
Scene hierarchy|场景对象树
Scene structure|场景结构
Scene tools|场景工具
Scroll in the viewport to push in and pull out.|在视口中滚动滚轮以推近或拉远。
Scroll to push in|滚轮推近或拉远
Scrub timeline|拖动播放头
Seated|坐姿
Seed|随机种子
Select a Shot block below to edit its camera.|选择下方镜头块以编辑其摄影机。
Select scene|选择场景
Selected Full-Body segment speed|选中全身片段的速度
Selected Full-Body segment speed value|选中全身片段的速度值
Selected block prompt|选中块的提示词
Selection|选中对象
Set how softly the rig catches up|设置骨架跟随的平滑程度
Set the camera view for your shot.|设置此镜头的摄影机视角。
Settings|设置
Shaded|带阴影
Shift: every shot|Shift：所有镜头
Shot|镜头
Shot camera|镜头摄影机
Shot curve|镜头曲线
Shot preset|景别预设
Shot view|镜头视图
Shots|镜头
Show|显示
Show the agent chat column (Cmd/Ctrl+B)|显示扩展说明面板（Ctrl/Cmd+B）
Skip guide|跳过引导
Snap|吸附
Speed|速度
Split|切分
Split at the playhead|在播放头处切分
Stage position — does not change the take|调整场景位置，不改变动作
Start from a scene|从场景开始
Start over|重新开始
Stop|停止
Storyboard (PNG)|故事板（PNG）
Subject|角色
Subjects|角色
T-pose|T 字姿态
Take editing|动作编辑
Take it again|重新生成动作
Take this shot with you. Its camera and range stay yours.|导出此镜头，保留摄影机与时间范围。
Take versions|动作版本
Target model|目标模型
Target video model|目标视频模型
That image is no longer in storage|此图片已不在存储中
That image is now used by a scene and was not deleted|此图片刚被场景使用，未删除
That image is used by a scene and was not deleted|此图片被场景使用，未删除
That is the whole camera: look, walk, dolly, orbit, cut, rail, play.|已完成摄影机教程：转动、移动、推拉、环绕、镜头、轨道与播放。
That picture format is not supported — use PNG, JPG, WebP or GIF|不支持此图片格式，请使用 PNG、JPG、WebP 或 GIF
The 3D view lost its graphics context|3D 视图的图形上下文已丢失
The live editor is disconnected. Reconnect before sending.|实时编辑器已断开，请重新连接后再发送。
The preview could not be read back|无法读取预览图像
The shot renderer is not ready|镜头渲染器尚未就绪
The take has no bridge source to regenerate from|此动作没有可供重新生成的桥接输入
Thinking|思考中
This image's usage changed, so it was not deleted. Please review it again.|图片的使用状态已改变，未删除，请重新检查。
Timeline view tools|时间轴视图工具
Timeline zoom|时间轴缩放
Tolerance|容差
Top|俯视
Top-View|俯视图
Trail falloff|轨迹影响范围
Transform|变换
Transform tools|变换工具
Travel speed|移动速度
Trim take end|裁剪动作结束
Trim take start|裁剪动作开始
Turn Waypoint off|关闭路径点模式
Turn Waypoint off to edit or preview this camera.|关闭路径点模式后可编辑或预览摄影机。
Turn anonymous analytics off|关闭匿名使用统计
Turn anonymous analytics on|开启匿名使用统计
Turn to face the direction of travel|朝向前进方向
Two-finger up/down over FRAME ruler to zoom — click to reset to 1×|在帧标尺上双指上下滑动以缩放，点击恢复 1 倍
Unavailable|不可用
Undo|撤销
Undo object deletion|撤销对象删除
Undone|已撤销
Unreadable|无法读取
Unsaved changes|有未保存修改
Untitled|未命名
Untitled Project|未命名工程
Untitled Scene|未命名场景
Untitled image|未命名图片
Untitled model|未命名模型
Untitled motion|未命名动作
Unused|未使用
Unused by every scene. Delete it?|没有场景使用此素材，是否删除？
Upload from this computer|从本机上传
Use URL|使用地址
Use a hosted or local route|使用托管或本地地址
Video (mp4)|视频（MP4）
Video URL|视频地址
Video capture|视频动作提取
View|视图
Viewport display|视口显示
Viewport display toggles|视口显示选项
Walk|行走
Walking|行走
Warm ↔ Cool|暖色 ↔ 冷色
Wave|挥手
Workflow|画布
You made your first shot.|第一个镜头已完成。
Your first 60 seconds|一分钟入门
angle relative to the subject's eyes|相对角色视线的角度
auto |自动 
average|平均
camera to subject|摄影机到角色的距离
click a Shot block's lower strip to key the current framing at that frame|点击镜头块下方区域，在对应帧记录当前构图
derived from the keyframings, not chosen from a list|根据关键帧计算的镜头运动
describe this motion block|描述此动作片段
drag the curve · double-click or the button cuts · Delete removes a cut|拖动曲线，双击或点击按钮切分，Delete 删除切点
empty = random|留空使用随机值
fills take|覆盖整个动作
generate fresh|重新生成
keep original|保留原始动作
light position|光源位置
nearest prime on the cropped filmback|根据裁切后的感光面计算的最近定焦焦距
off|关
on|开
s|秒
the drawn path replaces the root; the body keeps the take's style|绘制的路径替换根运动，身体保持动作风格
→ Viewport|→ 视口
↓ Timeline, Shots lane|↓ 时间轴的镜头轨道
궤적선 편집|轨迹线编辑
궤적선을 잡아 여러 프레임의 이동을 함께 수정합니다. 파츠 핸들은 잠시 잠겨 겹침을 막습니다.|拖动轨迹线可同时调整多帧运动，部位手柄暂时锁定以避免冲突。
모캡 품질 게이트 통과|动作捕捉质量检查通过
파츠를 직접 잡아 손·발·팔꿈치·무릎을 세밀하게 수정합니다. 궤적선은 안내선으로만 표시됩니다.|直接拖动身体部位，精细调整手、脚、肘和膝，轨迹线仅作为参考。
Torso|躯干
Root / Hips|根节点 / 髋部
Spine|脊柱
Chest|胸部
Neck|颈部
Head|头部
Left Arm|左臂
Left Shoulder|左肩
Left Elbow|左肘
Left Hand|左手
Right Arm|右臂
Right Shoulder|右肩
Right Elbow|右肘
Right Hand|右手
Left Leg|左腿
Left Knee|左膝
Left Foot|左脚
Right Leg|右腿
Right Knee|右膝
Right Foot|右脚
Primitives|基础形状
Set pieces|场景道具
Cube|立方体
Sphere|球体
Capsule|胶囊体
Cylinder|圆柱体
Cone|圆锥体
Plane|平面
Chair|椅子
Car|汽车
Plane (aircraft)|飞机
Motion extensions|动作扩展说明
This hosted director exports references. Start model generation explicitly in the canvas draft and review its model, parameters and expected cost there.|导演台导出参考素材。在画布生成草稿中主动发起模型生成，并确认模型、参数和预计费用。
Local GPU motion extraction, Kimodo/ProjFlow, direct fal generation and local OAuth agents are optional upstream extensions. They are not connected on this site.|本地 GPU 动作提取、Kimodo/ProjFlow、fal 直连和本机 OAuth 智能体属于上游可选扩展，本站未接入。
Mirror pose|镜像姿态
Mirror only the selected character's current pose|仅镜像当前选中角色的姿态
Pose mirrored|姿态已镜像
Could not mirror the selected pose|无法镜像所选姿态
Collapse hierarchy|收起对象树
Expand hierarchy|展开对象树
Collapse inspector|收起属性面板
Expand inspector|展开属性面板
Maximize viewport|最大化视口
Restore panels|恢复面板
Viewport layout|视口布局
Keyboard shortcuts|快捷键
W/E/R: move / rotate / scale · F: frame selection · Space: play / pause · Ctrl/Cmd+Z: undo · Ctrl/Cmd+Shift+Z: redo · Shift+Space: maximize viewport · Esc: restore panels|W/E/R：移动 / 旋转 / 缩放 · F：聚焦选中对象 · 空格：播放 / 暂停 · Ctrl/Cmd+Z：撤销 · Ctrl/Cmd+Shift+Z：重做 · Shift+空格：最大化视口 · Esc：恢复面板
Describe your character; this text remains yours|请输入角色描述，此处保留你的原文
The pose on the selected character.|当前选中角色的姿态。
Type a value and press Enter, or drag a number sideways to scrub (Shift for fine).|输入数值后按 Enter，或左右拖动数值调整，按住 Shift 微调。
Edit the selected subject's placement, turn and size. Drag the Transform tool in the viewport for direct manipulation.|编辑选中角色的位置、朝向和大小，也可直接拖动视口中的变换工具。
Choose a body group in the hierarchy, then manipulate its handle in the main view.|在对象树中选择身体部位，然后拖动主视图中的手柄。
Pushes interpenetrating body parts apart with IK and keys the fix. Whole clip walks the loaded motion and keys only the frames that changed.|使用 IK 修正身体穿插并记录关键帧；处理整个片段时只记录发生修正的帧。
Save the pose the character is in right now — with a motion loaded, that is the current frame plus IK corrections|保存角色当前姿态；加载动作时保存当前帧与 IK 修正结果
A character sheet or photo of this person. It travels with every framing capture so a render keeps the same face, hair and wardrobe.|此角色的设定图或照片，随构图参考一起导出，以保持脸部、发型和服装一致。
Everything you add to the set lives here. Pick one to edit it, or click it in the shot view. Drop a picture anywhere here — or on the shot view — to stand it up as a cutout. You can also drop a .glb, .obj or .fbx to import a 3D object.|场景道具显示在这里。选择道具编辑属性；拖入图片可创建平面卡片，拖入 GLB、OBJ 或 FBX 可导入 3D 对象。
Select something in the hierarchy — the scene, the camera, a character, the environment or a prop — and its settings appear here.|在对象树中选择场景、摄影机、角色、环境或道具，即可在这里编辑属性。
First/last frames, clip, camera and prompt as one zip — hold Shift for every shot|将首尾帧、参考视频、摄影机与提示词打包为 ZIP；按住 Shift 导出所有镜头
Render the shot to an MP4 — camera move and character motion, no editor chrome|把镜头渲染为 MP4，包含摄影机和角色运动，隐藏编辑界面
Blender-style viewport — dark void with a reference grid instead of the deck|使用深色背景与参考网格替代场景地面
The timeline flags this shot when the cut runs past the model's clip length or leaves its delivery ratios. Nothing is re-timed or re-cropped.|镜头超出模型支持的时长或画幅时，时间轴会提示；不会自动改变时长或裁切。
Root|根节点
Start|开始
End|结束
Apply|应用
OK|确定
Wide|远景
Medium|中景
Zoom in|放大
Zoom out|缩小
Size|大小
Prompt|提示词
Last frame|末帧
First frame|首帧
Copy prompt|复制提示词
Edit properties|编辑属性
Pose saved|姿态已保存
This image's scene references changed, so it was not deleted. Please review it again.|图片的场景引用已改变，未删除，请重新检查。
The scene changed while deleting, so the image was kept. Please review storage again.|删除期间场景发生修改，已保留图片，请重新检查存储。
MP4 encoding is unavailable. Use a current browser with H.264 WebCodecs support (such as Chrome or Edge), enable hardware acceleration, then retry.|MP4 编码不可用。请使用支持 H.264 WebCodecs 的新版 Chrome 或 Edge，开启硬件加速后重试。
Video encoding failed. Retry the same request. If resources are tight, shorten the shot range or lower output resolution before starting a new export.|视频编码失败，请重试。若资源不足，可缩短镜头范围或降低分辨率，再重新导出。
Frame rendering failed. Let the scene finish loading, then retry. If it repeats, shorten the range or reduce output resolution for a new export.|图像渲染失败，请等待场景加载完成后重试。若仍失败，可缩短范围或降低分辨率。
Export could not finish. Retry the same request. For memory or resource problems, close other heavy tabs or use a shorter range / lower output resolution in a new export.|导出未完成，请重试。若内存或资源不足，可关闭占用较高的标签页，或缩短范围、降低分辨率后重新导出。
Export completed. Download requested; check your browser's downloads. The OS save is not confirmed.|导出已完成并请求下载，请查看浏览器下载记录；尚未确认文件已保存到系统。
Finalizing MP4. Progress is indeterminate; this stage cannot be interrupted.|正在封装 MP4，暂时无法计算进度，此步骤无法中断。
Building the ZIP. Cancel takes effect after the current work unit, before download.|正在打包 ZIP，取消会在当前步骤完成后、下载前生效。
Retry keeps the original shot, camera, range and settings; it does not change your edits.|重试保留原镜头、摄影机、范围和设置，不修改编辑结果。
The view moved — the pending edit still applies; the dashed line is that same edit seen from here. Return toward the original view to grab it again, or Generate/undo from here.|视角已改变，待应用的编辑仍保留，虚线表示当前视角下的路径。返回原视角可继续拖动，也可生成或撤销。
The current take has no bridge source — generate it once before editing a path|当前动作没有桥接输入；路径重新生成属于未接入的扩展。
Path editing on — draw along the path to reroute that section, or grab a dot and pull; the view still orbits normally|路径编辑已开启：沿路径绘制可改道，拖动控制点可调整路径，视角仍可正常环绕。
The graphics context was lost — restoring the stage. If it stays black, reload the page; your work is autosaved.|3D 图形上下文丢失，正在恢复场景。若持续黑屏，请重新载入页面并检查工程恢复状态。
Waiting for the browser to restore it. If this stays, reload the studio — scenes autosave.|正在等待浏览器恢复 3D 视图。若持续未恢复，请重新载入导演台。
Look through the shot camera — right-drag, WASD and orbit set the recording lens (Esc returns)|查看镜头摄影机：右键拖动、WASD 与环绕操作调整摄影机，Esc 返回。
Follow rides the subject's motion — without a loaded motion the camera composes a static frame|摄影机跟随角色动作；未加载动作时保持静态构图。
IK mode is on — applying keys the pose as a full-body correction at the current frame; the motion stays.|IK 已开启，应用姿态会在当前帧添加全身修正关键帧，并保留原动作。
A sample motion is moving the character — applying a pose clears it and returns to the blocking pose.|角色正在播放示例动作，应用姿态会清除动作并恢复预演姿态。
Your pose library is empty. Read a pose out of a photograph, or pose the character and save it — both stay here for every project.|姿态库为空。可从照片提取姿态，或调整角色后保存，已保存姿态可在其他工程复用。
Review unused and in-use stored images. Deleted images can be restored until this page is reloaded.|查看已使用和未使用图片；本页重新载入前，可恢复删除的图片。
No imported images yet. Use “Import image as cutout” in the Props inspector, or drop or paste a picture into the studio.|暂无导入图片。可在道具属性中“导入图片卡片”，或将图片拖入、粘贴到导演台。
No imported models yet. Use “Import 3D object” in the Props inspector, or drop a .glb, .obj or .fbx into the studio.|暂无导入模型。可在道具属性中“导入 3D 对象”，或拖入 GLB、OBJ、FBX 文件。
Start with a named project, then place a character and frame the shot. Your work is saved in that project.|先创建工程，再放置角色、设置构图。编辑结果保存在此工程中。
Workflow output|画布输出
In project file|包含在工程文件中
External URL|外部地址
Browser-only copy|仅存于此浏览器
Missing|缺失
Project resources|工程素材
Missing resources|缺失素材
The project file would be too large.|工程文件过大，无法保存。
Unknown reason|未知原因
The project was not saved|工程未保存
Select, move, key, and play are the core CozyClay loop. You can close this guide and keep blocking.|选择、移动、添加关键帧和播放是基础编辑流程。可关闭引导并继续编辑。
Crane height: click to add, click a point to select, drag vertically to change height|升降高度：点击添加控制点，点击控制点选择，上下拖动调整高度
Pin the instant at the playhead: the spot being walked then never moves again|固定播放头所在时刻的走位位置
Pin the instant at the playhead: the spot being passed then never moves again|固定播放头所在时刻的经过位置
Lens height of the selected crane point — click a purple dot in the scene to pick one, double-click the lifted curve to add one|所选升降点的镜头高度：点击场景控制点选择，双击抬高的曲线添加
Choose whether the dolly starts at the rail head or the nearest useful point|选择从轨道起点还是最近有效位置开始移动
IK mode — drag a wrist / ankle handle; keys land on the Full-Body lane. With a motion loaded, keys correct it layer-style|IK 模式：拖动手腕或脚踝手柄，在全身轨道记录关键帧；已加载动作时作为修正层应用
Foot snap — keep the feet planted while you move the body (hips); the knees bend instead of the feet sinking through the floor|脚部固定：移动身体或髋部时保持脚部原位，通过膝盖弯曲避免穿入地面
Click the crane graph to add a point; click a point and drag it to change height|点击升降曲线添加控制点，拖动控制点改变高度
A picture of this location. It travels with every framing capture so a render takes its materials, palette and lighting from the real place.|此场景的参考图片，随构图一起导出，用于保持材质、配色与照明。
This card's background is removed. You are editing the original photograph — apply again to change what goes.|卡片背景已移除。此处编辑原图，重新应用可改变移除区域。
Drag over the background — the cut grows out from wherever the brush touches.|在背景上拖动画笔，移除选区会从画笔接触处扩展。
Tolerance is how far a drag spreads: low keeps to one flat colour, high walks across a shaded wall. It applies to the next drag and to Auto-detect, not to what is already purple.|容差决定选区扩展范围。较低值限制于相近颜色，较高值可覆盖阴影区域；只影响下次拖动和自动识别，不改变现有选区。
Cut out grows the selection from wherever you drag; Bring back is the same growth fenced to what is already selected, so one drag returns a wrongly-cut region whole. Applying removes exactly what is purple and trims the empty margin — the card keeps the original photograph and this selection, so you can come back and change your mind.|“移除区域”扩展选区，“恢复区域”取消选区中的区域。应用后移除标记区域并裁去空白边缘；原图和选区保留，可继续修改。
Blocks define what ARDY generates over each frame range. Selecting one also moves editing context to that prompt.|提示词块描述各帧范围的生成动作，ARDY 是本站未接入的上游扩展。
The joint's own path is drawn on the viewport — grab a point on it and pull, or draw a new path on empty space; the joint then follows it exactly. The view still orbits normally (Alt+drag).|关节路径显示在视口中；拖动控制点或在空白区域绘制新路径，关节随路径移动，仍可用 Alt 拖动环绕。
Scrub to a moment, then drag the green handle to where the joint should be. The take keeps its own timing; only that instant is pinned.|跳转到目标时刻，拖动绿色手柄设置关节位置，保留原动作时序，仅固定此刻。
Draw along the path to reroute that section — the frames you drew over become the range, and the take's own timing is kept. Or grab a yellow dot and pull.|沿路径绘制可改变该段路线，所覆盖帧成为编辑范围并保留时序，也可拖动黄色控制点。
You can still orbit (Alt+drag), pan and fly freely — the edit survives it. It was aimed through one lens, so while the view is elsewhere the line is drawn ghosted and a new pull waits; Generate, undo and Reset work from anywhere.|编辑保留时仍可环绕、平移和移动视角。离开原视角时路径以虚线显示，暂停新拖动；生成、撤销和重置可从任意视角操作。
You can still orbit (Alt+drag), pan and fly freely; the path follows the view until you pull or draw it.|仍可环绕、平移和移动视角，拖动或绘制前路径跟随视角更新。
The viewport is showing this edit at full quality — press Generate to keep it as the take.|视口正在显示完整预览，生成后可保留为动作。
How hard the regeneration holds the loaded take outside the frames you edited.|重新生成时对编辑范围以外原动作的保留程度。
Close-Up|特写
Low Angle|低机位
High Angle|高机位
Shot settings|镜头设置
Static / locked-off|固定机位
Push-in (dolly in)|推近
Pull-out (dolly out)|拉远
Pan left|向左摇摄
Pan right|向右摇摄
Tilt up|向上摇摄
Tilt down|向下摇摄
Tracking / follow|跟拍
Orbit / arc|环绕
Crane up|升起
Crane down|下降
Handheld|手持
Crash zoom in|快速变焦推近
Dolly-zoom (vertigo)|滑动变焦
Whip pan|快速摇摄
Aerial / drone|航拍
extreme close-up|大特写
close-up|特写
medium close-up|近景
medium shot|中景
medium-wide shot|中远景
wide shot|远景
extreme wide shot|大远景
overhead|顶视
high angle|高机位
eye level|平视
chest level|胸部高度
hip level|髋部高度
knee level|膝盖高度
ground level|地面高度
cube|立方体
sphere|球体
capsule|胶囊体
cylinder|圆柱体
cone|圆锥体
plane|平面
chair|椅子
car|汽车
aircraft|飞机
cutout|图片卡片
Mesh|网格模型
front|正面
back|背面
left profile|左侧
right profile|右侧
front ¾ L|左前方
front ¾ R|右前方
rear ¾ L|左后方
rear ¾ R|右后方
head|头部
left arm|左臂
right arm|右臂
left leg|左腿
right leg|右腿
regenerates the whole body|重新生成全身
Saved scenes were written by a newer CozyClay — they have been left untouched and this session will not save|已保存场景来自更高版本，原文件保留，本次会话不会覆盖保存。
The studio hit a render error|导演台渲染失败
Scenes autosave as you work, so reloading resumes from the last saved state.|重新载入会从最近一次完整保存的场景恢复。
Reload the studio|重新载入导演台
your AI video tool|视频生成工具
your selected image model|所选图像模型
 as the start frame, and | 作为首帧，并将 
 as the end frame.| 作为尾帧。
 as the reference frame.| 作为参考帧。
 as the reference image.| 作为参考图。
Your motion is ready|动作已就绪
Your shot is ready|镜头已就绪
Close the result|关闭结果
Camera move start frame|摄影机运动首帧
Camera move end frame|摄影机运动尾帧
Finished scene frame|场景渲染图
Camera move made from timeline keyframes|根据时间轴关键帧生成的摄影机运动
copied|已复制
Copied ✓|已复制 ✓
Download requested|已请求下载
Download start and end frames|下载首尾帧
Download frame|下载当前帧
Next · CozyClay motion source|下一步 · 动作输入素材
Use this video for mocap extraction|将此视频用于动作提取
The fixed-camera H3 Max Turbo video is attached to the extraction panel as a motion source. Run GVHMR there, then review the resulting take in the timeline.|此视频可作为动作输入素材；GVHMR 是本站未接入的上游扩展。
Handing off to your AI|准备模型参考素材
Copy the prompt|复制提示词
Copied. Paste it into your AI service's prompt box.|已复制，可粘贴到画布生成草稿的提示词输入框。
Press “Copy prompt” above, then paste it into your AI service.|点击上方“复制提示词”，再粘贴到画布生成草稿。
Download the frame|下载图像
Press “Download start and end frames” to save both PNGs.|点击“下载首尾帧”保存两张 PNG。
Press “Download frame” to save the PNG.|点击“下载当前帧”保存 PNG。
This result has no frame to download.|此结果没有可下载图像。
Attach the image to your AI|添加模型参考图
Use your AI service's image attach button to upload the start and end frames together.|在画布生成草稿中一同添加首尾帧。
Use your AI service's image attach button to upload blocking-frame.png.|在画布生成草稿中添加预演参考图。
The prompt describes the scene's content and mood; the frame shows the camera framing. Use both to reproduce this scene as closely as possible.|提示词描述内容和氛围，参考图表示摄影机构图，可共同用于模型生成。
Optional · Reference video|可选 · 参考视频
A video recorded with the recording feature: |参考视频：
 file. Use it separately from the reference frame in the prompt above.|。可与参考帧分别使用。
Unexplained body support|身体支撑无法解释
Floor penetration|穿入地面
Contact floats|接触点悬空
Contact drift|接触点漂移
Knee speed jump|膝盖速度突变
Knee acceleration increased|膝盖加速度增加
Root acceleration increased|根节点加速度增加
Playback mismatch|播放状态不一致
review before applying|应用前请检查
Floor-support hypotheses → force + moment check → pelvis + limbs. Flight is preserved; uncertain support stays flagged. Original stays unchanged until Apply.|根据地面支撑估计检查受力与力矩，再修正髋部及四肢。保留腾空运动，标记不确定支撑；应用前保留原动作。
Correction strength|修正强度
Contact overrides & protected poses|接触覆盖与受保护姿态
Support point|支撑点
Contact mode|接触模式
Plant|固定
Free / moving|自由 / 移动
Use playhead|使用播放头
Add interval|添加区间
Remove interval|删除区间
Protected|已保护
Unprotect pose|取消姿态保护
Analyse & preview|分析并预览
Analysis progress|分析进度
Original|原始动作
Corrected preview|修正预览
Measured|实测
Before|修正前
After|修正后
Max floor depth|最大地面穿入深度
Mean contact drift|平均接触漂移
Max contact drift|最大接触漂移
Max contact gap|最大接触间隙
Knee step / frame|每帧膝盖位移
Unsupported floating frames|无支撑悬空帧
Unexplained floating gap|无法解释的悬空间隙
Peak force residual|最大受力残差
Peak moment residual|最大力矩残差
Estimated floor support, not measured forces. Hidden props and joint torque limits are not modeled.|根据地面支撑估计受力，未测量实际力；未建模隐藏道具与关节力矩限制。
Analysis|分析
source measurements reused|复用原始测量
source measured|已测量原始动作
Peak knee acceleration|最大膝盖加速度
Peak root acceleration|最大根节点加速度
Measured on skinned mesh surfaces, not bone height.|根据蒙皮模型表面测量。
Surface unavailable: bone proxy only.|模型表面不可用，仅用骨骼代理。
No measured limit exceeded|未超过实测限制
Go to first unresolved contact|跳转到第一个未解决接触
`.split("\n").filter(line => line.includes("|")).map(line => {
	const at = line.indexOf("|");
	return [line.slice(0, at), line.slice(at + 1)];
})));

export function chineseLabel(text) {
	if (typeof text !== "string") return text;
	if (Object.hasOwn(ZH_CN, text)) return ZH_CN[text];
	// Only UI-generated numeric labels. Never translate substrings in names,
	// descriptions or prompts, and never send text to a translation service.
	const numbered = /^(Subject|Character|Scene|Shot) (\d+)$/.exec(text);
	if (numbered) return `${ZH_CN[numbered[1]]} ${numbered[2]}`;
	const frames = /^(\d+) frames$/.exec(text);
	if (frames) return `${frames[1]} 帧`;
	return text;
}
