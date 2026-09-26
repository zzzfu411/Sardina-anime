# Sardina anime 品牌与 Logo

2026-09-24 · v0.6.1

产品名为 **Sardina anime**；与用户另一个产品 **Sardina manga** 区分。只在侧栏、应用窗口与安装包使用小型标志和字标；发现页以推荐、继续观看为主体，不放大 Logo、搜索横幅或装饰封面墙。浅色灰纸与深色星空配色沿用 0.5.0。

## 当前组合

保留 v0.6.0 的 Sardina 手写字体（Bradley Hand），单独重画下面的 anime 小字。鱼标恢复最初原画，仅水平翻转朝右，与 manga 朝左的方向区分；原 PNG 与 Git 基线逐字节一致，网页镜像图与原缩略图的左右对应像素完全相同。没有修改鱼鳍、屏幕、表情或笔画。

侧栏图文上下居中：鱼图显示框 156 × 64，Sardina 主字标 32px，anime 小字作为独立透明图形。通过 CSS mask 使用浅色印泥红或深色淡蓝，高对比度使用 CanvasText。图片和小字为装饰，整个首页链接提供完整无障碍名称。

- 朝右网页图：[PNG](../apps/web/public/brand/sardina-anime-right.png)。原图只按用户要求水平翻转，无 AI 重画。
- anime 小字原图：[PNG](../assets/anime-lettering.png)，2172 × 724；[网页缩略图](../apps/web/public/brand/anime-lettering.png)。由内置 **image_gen** 生成，参考原界面左上角 Sardina 字体。
- 原始小鱼保留不变。macOS 图标导出时以水平镜像变换绘制原图。

## #097 · Yuru-Surreal Minimal Everyday Cartoon（原小鱼）

使用 `handdraw-style-prompter`，通过内置 **image_gen** 生成；本次确实传入了编号 **#097** 参考图，以及用户已选的 manga C「侧身阅读」Logo。模型能力未明确时按 unknown 处理，使用名称、正向特征与参考图。漫画版抱书，动漫版扶着动画播放画面，保留相同的小鱼轮廓与墨线语言。

- 原始透明 Logo：[PNG](../assets/sardina-anime-logo.png)，1536 × 1024。
- 网页缩略图：[PNG](../apps/web/public/brand/sardina-anime.png)，384 × 256；原始艺术保留不变，只缩放用于加载。
- 应用图标：[PNG](../assets/icon.png)、[ICNS](../assets/icon.icns)。使用 `scripts/create-icon.swift` 将原图水平镜像后按比例放入纸色 macOS 图标底板，生成系统要求的尺寸。
- Sardina 名称沿用 HTML 字体排版，anime 是新绘制的独立透明图形。

以下是中英复用提示词；参考素材说明附于末尾，原参考图不随仓库发布。实际生成由图像模型控制。本次生成使用中文正文与工具的图片参数。

## 中文提示词

```text
风格名称：#097 · Yuru-Surreal Minimal Everyday Cartoon。
参考作者/风格名称：のなか海 / Yuru-Surreal Minimal Everyday Cartoon。
主题：为动漫观看软件 Sardina anime 绘制手绘图形 Logo，融合一条沙丁鱼和 anime 动画观看元素，并与用户已有的 Sardina manga 标志呼应。第2张参考图是用户的漫画版小鱼 Logo，保留这条鱼的圆钝鱼身、点状眼睛、简洁鱼鳍和手绘墨线气质，动漫版用小小的动画播放画面替代漫画书：小鱼的鱼鳍扶着带播放三角和简洁动画角色轮廓的画面。一条鱼与动画画面构成完整标志，图形内不带文字；名称 Sardina anime 会由软件界面单独排版。保留纸白与墨黑，播放三角可用少量印泥红，透明背景，供浅色、深色侧栏与 macOS 应用图标使用。
核心风格特征：ゆるシュール、极简人物、反逻辑日常；脸部与服装主动做减法，依靠清楚轮廓、眼口和少量关键形状建立人物辨识度。
以下画风隔离说明仅针对第1张编号 #097 参考图，第2张是用户提供的品牌呼应参考。
所附图片仅用于参考画风。只提取参考图的风格特征，例如线条、笔触、媒介、材质、色彩倾向和整体视觉语言；不要使用、复制或延续参考图中的任何主体、人物、动物、服装、道具、动作、姿态、场景、背景、构图、布局、文字或故事。最终画面内容完全以用户提供的主题为准。
参考图片：本机 #097 风格参考图（不随仓库发布）
品牌参考：Sardina manga 小鱼标志（独立项目）
```

## English prompt

```text
Style name: #097 · Yuru-Surreal Minimal Everyday Cartoon.
Reference author/style name: のなか海 / Yuru-Surreal Minimal Everyday Cartoon.
Theme: Create a hand-drawn graphic logo for the anime watching application Sardina anime, combining one sardine and anime viewing elements, with a family resemblance to the user's Sardina manga logo. Reference image 2 is the existing manga fish logo: retain its blunt rounded body, dot eye, simple fins and hand-drawn ink character. For the anime version, replace the manga book with a small animation viewing screen held by the fish's fins, with a play triangle and a simple anime character outline. One fish and the viewing screen form the complete symbol. No lettering in the graphic; Sardina anime will be typeset by the interface. Retain paper white and ink black with a small seal-red play triangle, and a transparent background for the light and dark sidebar and macOS app icon.
Core style traits: Gently surreal, minimal characters and illogical everyday life; reduce facial and clothing detail, building recognizable character through a clear silhouette, eyes and mouth, and only a few essential shapes.
The following style isolation instruction applies only to reference image 1, numbered #097; image 2 is the user's existing brand reference.
Use the attached image only as a style reference. Extract only its stylistic qualities, such as linework, brushwork, medium, material texture, color tendencies, and overall visual language. Do not use, copy, or carry over any subject, person, animal, clothing, prop, action, pose, setting, background, composition, layout, text, or story from the reference image. The user's written theme is the sole source for the image content.
Style reference: local #097 style reference (not included in this repository)
Brand reference: the Sardina manga fish logo (a separate project)
```

## anime 小字：实际生成提示词

生成采用内置图像工具。参考图为原版界面截图，仅用于匹配左上角 Sardina 的字体；没有重新生成 Sardina 主名称或小鱼。提示词可在图像 AI 中复用，结果由该工具生成。

```text
Create a hand-drawn lettering asset with the exact single lowercase word "anime" (a-n-i-m-e), for the small subtitle under the Sardina application name. The attached screenshot is a visual reference: use only the original handwritten "Sardina" lettering at its upper left to match the type family. Keep that light, informal ink-handwritten character. Draw the five lowercase letters with clear, simple shapes, a small round dot on the i, slightly right-leaning strokes and gentle natural irregularity. The result should feel like the same hand wrote Sardina and anime, while staying readable at a small subtitle size. Medium-light ink strokes and natural spacing; avoid the heavy rounded-serif lettering from the discarded redesign. Render ONLY the word anime in solid black ink on a genuinely transparent background. No Sardina word, no fish, no other letters, no illustration, no background panel or border. This is a standalone image asset; the existing Sardina text stays unchanged in the app.
```

中文对应：

```text
为 Sardina 软件名称下面的小标题绘制单独的小写单词 anime（a-n-i-m-e）。仅参考原界面左上角 Sardina 的轻松墨线手写风格。五个字母形状清楚、简单，i 使用小圆点，笔画略向右倾，保留温和自然的不规则感，仿佛两行名称出自同一只手。以适中的细墨线和自然字距保持小尺寸可读性，避开被否定的粗圆衬线风格。只绘制黑墨 anime 字样，真正透明背景，不生成 Sardina、小鱼、其他文字或底板。软件里原有的 Sardina 名称保持不变。
```
