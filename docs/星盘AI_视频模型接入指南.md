# 星盘AI 视频模型接入指南

版本：2026-09-18 · 本文列出13个视频型号，价格单位为人民币。

## 1. 地址、密钥与接口

- Base URL：`https://xingpan.site/v1`
- 所有创建、查询、下载、上传请求均携带：`Authorization: Bearer YOUR_API_KEY`。
- `YOUR_API_KEY` 替换为本站完整密钥；不要使用其他平台的密钥，也不要在密钥前重复添加 `sk-`。
- H3 使用“视频专线”密钥；Seedance、Wan 支持 `default` 和“视频专线”。密钥设置了模型限制时，须勾选对应型号。

| 操作 | 方法与地址 | 请求/返回 |
|---|---|---|
| 查看本密钥可用型号 | `GET /v1/models` | JSON |
| 上传参考素材 | `POST /reference-assets` | 文件原始内容 → JSON；此地址不带 `/v1` |
| 创建视频 | `POST /v1/videos` | JSON → 异步任务 |
| 查询任务 | `GET /v1/videos/{id}` | JSON |
| 下载视频 | `GET /v1/videos/{id}/content` | 视频文件 |

创建接口使用 `Content-Type: application/json`。不要把视频任务提交到聊天或图片接口。API客户端选用支持自定义 `/videos` 的方式；仅支持聊天的客户端无法直接完成本流程。

## 2. 当前型号与价格

`model` 使用下表完整API名称。清晰度由型号确定，不要用 `resolution` 或 `size` 把低清型号改成高配档。

| 型号名称 | API model | 清晰度档位 | 请求时长（整数秒） | 标准单价 |
|---|---|---|---|---|
| H3 768P 按秒 | `minimax-h3-768p-per-second` | 768P | 4–15 | ¥0.15/秒 |
| H3 2K 按秒 | `minimax-h3-2k-per-second` | 2K | 4–15 | ¥0.20/秒 |
| 能力受限768p | `minimax-h3-768p-limited` | 768P | 6 / 10 / 15 | ¥1.50/次 |
| 满参慢速版768p | `minimax-h3-768p-full-slow` | 768P | 1–15 | ¥0.10/秒 |
| SD 2.5 稳定480P | `seedance-2.5-vip-480p` | 480P | 4–30 | ¥0.55/秒 |
| SD 2.5 稳定720P | `seedance-2.5-vip-720p` | 720P | 4–30 | ¥1.18/秒 |
| SD 2.5 稳定1080P | `seedance-2.5-vip-1080p` | 1080P | 4–30 | ¥4.38/秒 |
| SD 2.5 折扣480P | `seedance-2.5-discount-480p` | 480P | 4–30 | ¥0.44/秒 |
| SD 2.5 折扣720P | `seedance-2.5-discount-720p` | 720P | 4–30 | ¥0.66/秒 |
| SD 2.5 特殊480P | `seedance-2.5-special-480p` | 480P | 4–30 | ¥0.63/秒 |
| SD 2.5 特殊720P | `seedance-2.5-special-720p` | 720P | 4–30 | ¥0.88/秒 |
| Wan 3.0 | `wan-3.0` | 1080P | 5–30 | ¥0.45/秒 |
| Wan 3.0 Prime | `wan-3.0-prime` | 1080P | 5–30 | ¥0.45/秒 |

SD 即 Seedance。稳定、折扣、特殊是不同型号，参数不能混用。Wan、Prime 为独立版本，当前公开参数与价格相同，不保证Prime画质或速度更优。

**计费：**按秒型号的标准费用＝单价×请求的 `seconds`；能力受限768p为每次任务固定¥1.50；满参慢速版768p按请求输出秒数计费，1/5/10/15秒分别为¥0.10/0.50/1.00/1.50。H3多渠道768P的4秒为¥0.60；2K的4/5/15秒为¥0.80/1.00/3.00；Wan的10秒为¥4.50。专属分组以账户实际价格为准。按请求秒数计费，不按成片的小数秒重新计算。创建受理后可能先预扣额度；明确生成失败按原任务退款，不确定状态须查询原任务或联系支持核对。

**旧型号迁移：**`MiniMax-H3-720P`、`MiniMax-H3-2K` 及对应小写别名已停止新建任务。请分别改用上表两个按秒型号，不要只修改时长。已有任务继续使用原任务ID查询、下载，原账单不改。

## 3. 画幅、素材与模式

**未填写比例时，本站请求参数默认 `16:9`。** 如需竖屏，明确填写 `metadata.ratio: "9:16"`；H3首帧/首尾帧模式的实际画幅规则见下文。使用英文冒号；不要写成 `16：9`、`16/9`、`1920x1080`。指定值必须在型号的支持范围内。

| 系列 | 图片 / 视频 / 音频上限 | 总素材上限 | `ratio` 可选值 |
|---|---|---|---|
| H3 多渠道按秒两档 | 9 / 3 / 3 | 12 | `16:9`、`9:16`、`1:1`、`4:3`、`3:4`、`auto` |
| SD 稳定/折扣480P、720P | 30 / 10 / 10 | 50 | `16:9`、`9:16`、`1:1`、`4:3`、`3:4`、`21:9` |
| SD 稳定1080P | 30 / 10 / 10 | 50 | `16:9`、`9:16`、`1:1` |
| SD 特殊 | 30 / 9 / 9 | 48 | `16:9`、`9:16` |
| Wan、Prime | 10 / 5 / 5 | 20 | `16:9`、`9:16`、`1:1`、`4:3`、`3:4` |

分项数量和总数必须同时满足。H3多渠道按秒两档及能力受限768p不能只有参考音频，必须同时带图片或视频。SD参考视频合计时长向上取整后须≤30秒，由服务端检测；无需自行填写 `input_video_duration`。

`metadata.mode` 按以下方式选择：

| 用途 | H3多渠道按秒两档 | SD | Wan / Prime |
|---|---|---|---|
| 纯文字 | `text_to_video`，不填素材 | `references`，不填素材 | `text_to_video`，不填素材 |
| 普通素材参考 | `omni_reference` | `references` | `omni_reference` |
| 一张图片 | `frames`＋`first_frame_url` | `references`＋一张 `image_urls` | `image_to_video`＋一张 `image_urls` |
| 首尾帧 | `frames`＋首尾帧地址 | `frames`＋首尾帧地址 | 不支持 |

普通素材使用 `metadata.image_urls`、`video_urls`、`audio_urls` 字符串数组，按数组顺序描述第一张图、第二张图等。H3单图首帧与普通参考用途不同，需保持普通参考身份时明确选 `omni_reference`。Wan单图模式恰好一张图，不能同时带视频、音频。参考模式需有素材，SD的纯文字 `references` 除外。

首尾帧使用 `metadata.first_frame_url`、`last_frame_url`。SD两者必须同时提供；H3多渠道按秒两档可只提供首帧，不可只提供尾帧。**首尾帧不要同时发送普通素材数组**。H3首帧/首尾帧模式的画幅主要由素材决定，不能保证按 `ratio` 强制裁切；即使填写 `16:9`，结果也可能跟随素材画幅。需要固定构图时，先将输入图片裁剪为相同的目标比例，下载后再核验输出。

- `metadata.generate_audio`：仅SD稳定/折扣与Wan支持，值为布尔 `true`/`false`，不要传字符串。关闭声音用 `false`。
- `metadata.face_mode`：仅SD稳定/折扣支持；启用时须有参考图片或首尾帧。
- H3声音遵循模型默认；H3及SD特殊不发送以上开关。
- H3多渠道按秒两档提示词上限60000字符；SD稳定60000、折扣/特殊5000；Wan32000。

H3请求无需传入IR参数。

### H3 能力受限版与满参慢速版

两款均使用本站相同的创建、查询、下载接口及“视频专线”密钥，不自动切换成其他型号。能力受限版为¥1.50/次；满参慢速版为¥0.10/请求输出秒，默认15秒为¥1.50。“满参”表示下列参考素材和模式较完整，不代表开放所有上游参数。

- **能力受限768p**：仅6、10、15秒，默认15秒；仅16:9。最多9图、3音频，合计12个，不支持视频参考或首尾帧。单图和多图均使用 `omni_reference`＋`metadata.image_urls`，音频须搭配图片。本站提示词上限7000字符。
- **满参慢速版768p**：1–15整数秒，默认15秒；支持16:9、9:16、1:1、4:3、3:4、21:9、auto，auto必须带图片或视频。9图/3视频/3音频、合计12个；允许只有音频。普通素材用 `omni_reference`；`frames` 可只给首帧、只给尾帧或首尾各一张，不能混用普通素材，首尾图片比例差不超过2%。提示词转换后最多7000字符。
- 满参慢速版单张图≤30,000,000字节、视频≤50,000,000字节、音频≤15,000,000字节。本站开放PNG/JPEG/WebP、MP4、MP3/WAV/M4A；不接受WebM参考视频。每段视频/音频2–15秒，各类型合计≤15秒，超出请先裁剪；不会静默截断。图片须为静态图，边长256–5760、总像素≤33,177,600、宽高比0.4–2.5；视频须H.264/H.265编码。素材还须通过服务端实际格式检查。
- 两款都不传 `generate_audio`、`face_mode` 或IR参数。提示词用 `@1` / `@图片1`、`@视频1`、`@音频1` 引用各类数组的序号。
- 2026-09-16两条上游均有15秒、8图成片证据（1344×768）；观察用时分别约14分钟、23分钟，仅为样本，不保证交付时长。其他参数组合依据接口文档与模拟校验，未全部付费成片验证。慢速版进度达到100%但状态仍为running时，继续查询，只有completed才可下载。

## 4. 上传参考素材

| 文件 | 格式 | 单文件上限 | Content-Type 示例 |
|---|---|---|---|
| 图片 | PNG、JPEG、WebP | 30 MiB（30×1024²字节） | `image/png`、`image/jpeg`、`image/webp` |
| 视频 | MP4、WebM | 100 MiB | `video/mp4`、`video/webm` |
| 音频 | MP3、WAV、M4A | 30 MiB | `audio/mpeg`、`audio/wav`、`audio/mp4` |

上传发送文件原始内容，不是JSON、Base64或multipart表单。以下cURL命令为单行写法；Windows PowerShell使用 `curl.exe`。

```bash
curl --fail-with-body -sS 'https://xingpan.site/reference-assets' -H 'Authorization: Bearer YOUR_API_KEY' -H 'Content-Type: image/png' --data-binary '@reference.png'
```

从上传响应读取 `url`，填到对应素材字段。`expires_at` 是Unix秒时间戳，素材有效期24小时；视频/音频还会返回检测时长 `duration_seconds`。建议最多并行上传3个文件，**全部上传成功后才创建一次任务**。

也可使用无需登录、可公网访问的HTTPS素材直链。网页分享地址、需要Cookie的链接、本机路径、内网地址不能代替素材直链。类型伪装、文件过大、素材过期、无法探测视频时长或字段无法识别时，应先修正问题；平台不会丢掉有问题的素材后继续生成。

## 5. 创建请求与完整示例

统一请求结构：顶层填写 `model`、`prompt`、`seconds`，型号选项放入 `metadata`。建议每次显式填写整数 `seconds` 和 `metadata.ratio`；不要同时传不同值的 `duration`/`seconds` 或在多个层级重复参数。

将下面一个JSON示例保存为UTF-8的 `request.json`，再提交：

```bash
curl --fail-with-body -sS 'https://xingpan.site/v1/videos' -H 'Authorization: Bearer YOUR_API_KEY' -H 'Content-Type: application/json' -H 'Idempotency-Key: YOUR_UNIQUE_REQUEST_ID' --data-binary '@request.json'
```

**生产接入必须在创建请求中显式传入 `Idempotency-Key`。** 值建议用UUID，每个新任务一个值；统一使用8–128个字母、数字或 `._:-` 字符，以兼容所有视频型号。保存它与原请求、返回的任务ID。重试原任务必须使用**同一API密钥、完全相同的 `Idempotency-Key`、模型和请求体**；同键换内容会冲突，不要用换键的方式重试不确定任务。

H3 多渠道两个按秒型号必须传合法幂等键，缺失或非法会直接报错。其他型号未传此请求头时可能仍受理，但自动去重的默认窗口仅为15分钟。生产客户端不要依赖自动去重。

**其他视频型号的显式幂等键默认防重窗口为24小时，从首次受理时开始计算。** 不要把它当作永久订单号，也不要依赖重试延长窗口。已有任务ID时直接查询原任务；超过24小时，或无法确定首次是否受理及受理时间时，联系支持核对，不再通过重复POST验证结果。超窗后不能保证相同幂等键仍阻止重复创建或扣费。

H3 多渠道两个按秒型号使用持久任务幂等：创建后返回 `vjob_` 开头的任务ID和 `executor_version: 2`，重试恢复原任务。每笔新生成必须使用新键，不要复用历史任务的键。已有任务ID时直接查询，不通过新建任务恢复下载。

H3 会按素材、画幅、时长和清晰度选择兼容渠道串行尝试，价格与客户参数保持不变。明确的生成失败可切换备用；超时、500或查询失败进入核对，不盲目重复生成。内容安全拒绝会终止。查询中的 `stage: reconciling` / `needs_review` 表示待核对，`switching` 表示切换中；均不是最终失败。仅在 `status: completed` 且 `content_ready: true` 后下载。父任务只结算一次，所有兼容候选明确失败只退回一次预留。

### H3：最小768P文生视频

```json
{
  "model": "minimax-h3-768p-per-second",
  "prompt": "清晨海边小镇，一辆红色自行车从左向右驶过，镜头缓慢前进，自然光，动作连贯。",
  "seconds": 4,
  "metadata": { "ratio": "16:9", "mode": "text_to_video" }
}
```

改为2K时只替换 `model` 为 `minimax-h3-2k-per-second`，4秒价格变为¥0.80。

### H3：多图参考8秒

```json
{
  "model": "minimax-h3-768p-per-second",
  "prompt": "保持第一张图的人物外观，使用第二张图的场景，人物沿走廊缓慢前进，面部和服装保持一致。",
  "seconds": 8,
  "metadata": {
    "ratio": "16:9",
    "mode": "omni_reference",
    "image_urls": ["https://example.com/person.png", "https://example.com/scene.png"]
  }
}
```

### SD：图片、视频和音频参考

```json
{
  "model": "seedance-2.5-discount-720p",
  "prompt": "保持参考人物外观，参考视频中的运镜，并使用参考音频营造氛围，画面与动作连贯。",
  "seconds": 10,
  "metadata": {
    "ratio": "16:9",
    "mode": "references",
    "image_urls": ["https://example.com/person.png"],
    "video_urls": ["https://example.com/motion.mp4"],
    "audio_urls": ["https://example.com/sound.mp3"],
    "generate_audio": true
  }
}
```

没有使用的素材数组直接省略。若改用SD特殊型号，删除 `generate_audio`。

### Wan：单图生成并关闭声音

```json
{
  "model": "wan-3.0",
  "prompt": "画中人物自然转头看向镜头，保持原有外观，背景轻微运动。",
  "seconds": 5,
  "metadata": {
    "ratio": "9:16",
    "mode": "image_to_video",
    "image_urls": ["https://example.com/person.png"],
    "generate_audio": false
  }
}
```

### H3：首尾帧生成

```json
{
  "model": "minimax-h3-2k-per-second",
  "prompt": "从首帧平滑过渡到尾帧，保持人物与场景一致，动作自然。",
  "seconds": 5,
  "metadata": {
    "ratio": "16:9",
    "mode": "frames",
    "first_frame_url": "https://example.com/start.png",
    "last_frame_url": "https://example.com/end.png"
  }
}
```

以上 `example.com` 地址均为占位符，必须替换为真实可访问素材地址。

## 6. 受理、查询与下载

创建成功是**任务已受理，不代表视频已经生成**。创建请求返回成功响应后，解析并保存响应 `id`，不要依赖ID的前缀或自行拼造编号。受理响应结构示意：

```json
{
  "id": "TASK_ID_FROM_RESPONSE",
  "model": "minimax-h3-768p-per-second",
  "status": "queued",
  "progress": 0
}
```

把示例 `TASK_ID` 替换成创建响应中的 `id`。建议每5–10秒查询一次；遇到 `Retry-After` 时至少等对应秒数。

```bash
curl --fail-with-body -sS 'https://xingpan.site/v1/videos/TASK_ID' -H 'Authorization: Bearer YOUR_API_KEY'
```

| 字段/状态 | 客户端处理 |
|---|---|
| `status=queued` | 排队中，继续查询 |
| `status=in_progress` | 提交或生成中，继续查询；进度不是剩余时间承诺 |
| `delivery_status=delivering` | 视频正在保存和校验，继续查询；此时通常仍是 `in_progress` / 99% |
| `status=completed` 且未过期 | 尝试下载；若有 `delivery_status`，等待其为 `ready` |
| `status=failed` | 停止轮询，读取 `error`，核对原任务费用 |
| `status=cancelled` | 停止轮询，按取消状态展示并核对费用；`error` 可能不存在，不应强制读取 |
| `download_expired=true` 或 `delivery_status=expired` | 下载已过期；不要继续轮询期待恢复文件 |

`delivery_status`、`download_expires_at`、`download_expired` 为可选字段，客户端兼容其缺失。`download_expires_at` 是Unix秒时间戳。不要把 `delivering` 只当作主 `status` 的一个值。

完成后下载：

```bash
curl --fail --show-error --silent -L 'https://xingpan.site/v1/videos/TASK_ID/content' -H 'Authorization: Bearer YOUR_API_KEY' --output video.part --write-out 'HTTP=%{http_code} Content-Type=%{content_type}'
```

上例先写入 `video.part`，请在新的下载目录执行，避免覆盖已有文件。**只有cURL退出码为0、HTTP为200且响应类型正确时，才能把它作为成片使用：**

- `Content-Type: video/mp4`：将临时文件命名为 `video.mp4`。
- `Content-Type: video/webm`：将临时文件命名为 `video.webm`，不能只改后缀当成MP4。
- JSON、HTML、缺失类型或其他类型：不要交给播放器；检查响应并联系支持。不要把 `application/octet-stream` 直接认定为有效视频，须另行检查容器格式。

`--fail` 会将HTTP错误视为失败，并避免把错误响应体当成正常下载保存；网络中断仍可能留下不完整的临时文件，不能使用。集成到程序时也必须执行退出/状态、媒体类型检查；严格验收再检查容器和完整解码。若需查看错误详情，另行请求并输出到终端，不覆盖成片文件。

需要断点续传时可使用单段 `Range: bytes=起始位置-`，成功分段响应为206；须核对 `Content-Range` 起止位置及总长度，再写入正确偏移，不能把分段单独当成完整成片。

结果下载需要鉴权，不能把受保护地址直接放进不带请求头的 `<video src>`。网页客户端可先带Bearer请求获取Blob，再通过 `URL.createObjectURL(blob)` 播放；不要把API密钥放进URL。

成片缓存有效期24小时，尽快下载到自己的存储；以响应到期字段为准，查询和重复下载不会续期。历史任务记录仍存在不代表视频文件永久保存。

## 7. 超时和报错处理

| 情况 | 正确处理 |
|---|---|
| 比例、时长、素材等参数报400 | 按型号限制修正；勿用不支持的比例或混合首尾帧与普通素材 |
| 密钥无效、权限或模型不可用 | 检查密钥状态、有效期、分组、余额、模型白名单，并用 `/v1/models` 确认型号 |
| 409 `idempotency_conflict` | 幂等键对应的请求内容不同，核对原任务；不要把它当成新任务已成功 |
| 下载409 `task_not_ready` | 尚未准备好，按 `Retry-After` 继续查询原任务 |
| 下载503 `video_delivering` | 正在准备文件，稍后重试同一个下载地址，不重新生成 |
| 下载410 `video_download_expired` | 文件过期，停止下载重试 |
| 404 | 核对任务ID与使用的密钥，确认是否有访问权限；联系支持，不自动新建任务 |
| 查询或下载发生429/5xx/网络断开 | 遵循 `Retry-After`，退避后重试同一个GET请求，不重新创建任务 |
| H3多渠道两个按秒型号创建发生429/超时/5xx/网络断开 | 已有任务ID时查询原任务；没有ID时，遵循 `Retry-After`，使用同一API密钥、完全相同的 `Idempotency-Key`、模型和请求体重试POST，恢复原父任务。仍无法确认时联系支持，勿换键提交 |
| 其他型号创建发生429/超时/5xx/网络断开 | 已有任务ID时查询原任务；没有ID且确认在首次尝试后24小时内时，遵循 `Retry-After`，使用同一API密钥、完全相同的 `Idempotency-Key`、模型和请求体重试POST。超窗、首次时间不明或仍不确定时联系支持，勿换键提交 |

`Retry-After` 存在时，等待其指定的秒数或HTTP日期后再重试；未提供时逐步增加重试间隔。使用24小时幂等窗口的型号，等待后若已超窗，不再重试创建请求。

关闭页面或客户端超时不会取消后台任务。不要根据HTTP 200、扣费记录或单次查询失败判断成片成功/失败。联系客服时提供本站任务ID、请求时间、型号和脱敏错误信息，不提供API密钥。
