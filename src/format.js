import { formatFooterTime, formatShortTime, truncate } from './util.js';
import { stripLeadingMentions } from './tweet.js';

/**
 * 把一条推文渲染成发到 QQ 群里的文本。
 * 默认 compact，尽量贴近 QQ 链接卡片的行文：名字 / 正文 / 查看原帖 / 时间。
 */
export function formatTweet(tweet, cfg) {
  const name = cfg.x.displayName || tweet.author || 'X';
  const compact = cfg.forward.compact !== false;
  const time = tweet.published
    ? compact
      ? formatShortTime(tweet.published, cfg.forward.timeZone)
      : formatFooterTime(tweet.published, cfg.forward.timeZone)
    : '';

  const marks = [];
  if (tweet.isReply) marks.push('回复');
  if (tweet.isRetweet) marks.push('转推');
  const mark = marks.length ? `（${marks.join('·')}）` : '';

  // 纯图片推文没有正文时不再塞占位文案，直接留空
  const rawBody = tweet.text?.trim() || '';
  const body = tweet.isReply ? stripLeadingMentions(rawBody) : rawBody;
  const linkLine =
    cfg.forward.includeLink !== false && tweet.link
      ? compact
        ? `查看原帖 ↗ ${tweet.link}`
        : `🔗 ${tweet.link}`
      : '';

  const parts = [];
  if (tweet.repostName) {
    parts.push(`⇄ ${tweet.repostName} 已转帖`);
    if (tweet.repostTime) {
      parts.push(`> 转帖于 ${formatFooterTime(tweet.repostTime, cfg.forward.timeZone)}`);
    }
    parts.push('');
  }
  if (compact) {
    parts.push(mark ? `${name} ${mark}` : name);
    if (body) parts.push('', body);
    if (linkLine) parts.push('', linkLine);
    if (time) parts.push(time);
  } else {
    parts.push(`【${name}】新推文`);
    if (time) parts.push(`🕒 ${time}`);
    if (mark) parts.push(mark);
    if (body) parts.push('', body);
    if (linkLine) parts.push('', linkLine);
  }

  return truncate(parts.join('\n'), cfg.forward.maxChars ?? 1200);
}

/** Ark 结构化卡片（模板 24：文本+缩略图），需要平台授予 Ark 权限。 */
export function buildArkCard(tweet, cfg, imageUrl) {
  const name = cfg.x.displayName || tweet.author || 'X';
  const time = tweet.published ? formatShortTime(tweet.published, cfg.forward.timeZone) : '';
  return {
    templateId: cfg.forward.arkTemplate ?? 24,
    kv: [
      { key: '#DESC#', value: `${name} 新推文` },
      { key: '#PROMPT#', value: '查看原帖' },
      { key: '#TITLE#', value: name },
      { key: '#METADESC#', value: truncate(tweet.text || '', 120) },
      { key: '#IMG#', value: imageUrl || '' },
      { key: '#LINK#', value: tweet.link || '' },
      { key: '#SUBTITLE#', value: time },
    ],
  };
}

const URL_RE = /https?:\/\/[^\s<>()（）「」]+/g;
/** 引用 X 长文时，块内最多展示摘要的前多少字 */
const ARTICLE_EXCERPT_CHARS = 200;
const MENTION_RE = /(?<![\w@])@([A-Za-z0-9_]{1,15})(?![\w@])/g;
// X 的标签可以用中文/假名/数字/下划线，碰到空白、标点、emoji 就结束
const HASHTAG_RE = /(?<![\w#@])#([\p{L}\p{N}_]{1,80})/gu;
// 兜底用：要求标签前后都是边界，避免把后面紧贴的汉字一起吞进链接
const HASHTAG_BOUNDARY_RE = /(?<![\w#@])#([\p{L}\p{N}_]{1,40})(?![\p{L}\p{N}_])/gu;

/**
 * 把正文里的 @某人 变成和 X 一样的可点击链接（只看提及，不看标签）。
 * 邮箱（`a@b.com`）和 URL 里的 @ 不动；链接只认 1-15 位的 X 用户名。
 */
export function linkifyMentions(text) {
  const src = String(text || '');
  if (!src.includes('@')) return src;

  // 先把 URL 挖出来挡住，免得到 URL 里去找 @
  const urls = [];
  const masked = src.replace(URL_RE, (m) => {
    urls.push(m);
    return `\u0000${urls.length - 1}\u0000`;
  });

  const linked = masked.replace(MENTION_RE, (_m, handle) => {
    return `[@${handle}](https://x.com/${handle})`;
  });

  return linked.replace(/\u0000(\d+)\u0000/g, (_m, i) => urls[Number(i)] ?? '');
}

/** 从**原文**里取出所有标签（原文有空格和标点，边界是准的）。 */
export function extractHashtags(text) {
  return [...String(text || '').matchAll(HASHTAG_RE)].map((m) => m[1]);
}

/**
 * 正文里的 @提及 和 #标签 都变成可点击链接，和 X 客户端一致：
 * - `@某人` → `https://x.com/某人`
 * - `#标签` → `https://x.com/hashtag/标签`
 * 邮箱和 URL 里的内容原样保留。
 *
 * `options.hashtags` 传入原文里的标签时，会按这些边界精确替换 ——
 * X 的译文常把标签后面的空格吃掉（`#早稲田祭 お疲れ様` → `#早稲田祭感谢大家`），
 * 只看译文的话会把后面整句汉字都吞进链接里。
 */
/**
 * 按上限截断卡片。不能直接截字符：可能切在 `![alt #600px #400px](url)` 中间，
 * QQ 那边会显示成半截 Markdown。所以优先在换行处切，并且丢掉截断的链接/图片行。
 */
export function truncateMarkdown(text, max) {
  const src = String(text || '');
  const limit = Number(max) > 0 ? Number(max) : 0;
  if (!limit || src.length <= limit) return src;

  let cut = src.slice(0, limit);
  const nl = cut.lastIndexOf('\n');
  if (nl > limit * 0.5) cut = cut.slice(0, nl);

  // 最后一行如果起了个链接/图片却没闭合，整行去掉
  const open = cut.lastIndexOf('](');
  if (open >= 0 && !cut.slice(open).includes(')')) {
    const prevLine = cut.lastIndexOf('\n');
    cut = prevLine > 0 ? cut.slice(0, prevLine) : cut.slice(0, open);
  }
  return `${cut.trimEnd()}…`;
}
/**
 * 长链接的显示文字：`idol-afterschool.com/…`（只留域名 + 省略号，点开还是原链接）。
 */
export function urlLinkLabel(url) {
  try {
    const u = new URL(url);
    const host = u.host.replace(/^www\./i, '');
    const hasMore = (u.pathname && u.pathname !== '/') || u.search || u.hash;
    return hasMore ? `${host}/…` : host;
  } catch {
    return '链接';
  }
}

/**
 * 超长链接改成 Markdown 跳转链接，避免整条 URL 把卡片撑爆。
 * `maxChars` 为 0/未配置时不处理。
 */
export function shortenLongUrls(text, maxChars) {
  const limit = Number(maxChars);
  if (!limit || limit <= 0) return String(text || '');
  return String(text || '').replace(URL_RE, (url) =>
    url.length > limit ? `[${urlLinkLabel(url)}](${url})` : url,
  );
}

/**
 * 图文里「#后面一串字」应该切到哪：优先用原文的已知标签，
 * 支持三种情况：整段就是标签、标签是前缀（后面紧跟正文）、
 * 或者被译文改了字（論→论）但要按长度对回原文。
 */
export function resolveHashtagRun(run, known = []) {
  const text = String(run || '');
  if (!text) return { tag: '', rest: '' };
  if (known.includes(text)) return { tag: text, rest: '' };

  let best = null;
  for (const candidate of known) {
    if (!candidate || candidate.length > text.length) continue;
    const head = text.slice(0, candidate.length);
    if (head === candidate) {
      if (!best || candidate.length > best.length) best = candidate;
      continue;
    }
    let same = 0;
    for (let i = 0; i < candidate.length; i += 1) {
      if (head[i] === candidate[i]) same += 1;
    }
    if (same >= Math.ceil(candidate.length * 0.6) && (!best || candidate.length > best.length)) {
      best = candidate;
    }
  }
  if (best) return { tag: best, rest: text.slice(best.length) };
  return { tag: text, rest: '' };
}

/**
 * 在原文标签表里找出「疑似同一个」标签：长度相同、六成以上的字位置一致。
 * 译文把 論 改成 论 这种就靠它还原，避免链到一个空标签页。
 */
export function similarHashtag(tag, known = []) {
  const text = String(tag || '');
  if (!text) return null;
  let best = null;
  let bestScore = 0;
  for (const candidate of known) {
    if (!candidate || candidate.length !== text.length) continue;
    let same = 0;
    for (let i = 0; i < text.length; i += 1) {
      if (candidate[i] === text[i]) same += 1;
    }
    if (same > bestScore) {
      bestScore = same;
      best = candidate;
    }
  }
  if (!best) return null;
  return bestScore >= Math.ceil(text.length * 0.6) ? best : null;
}

export function linkifyEntities(text, options = {}) {
  const src = String(text || '');
  const limit = Number(options.longUrlChars);
  const hasEntities = src.includes('@') || src.includes('#');
  const hasLongUrl = limit > 0 && /https?:\/\//i.test(src);
  if (!hasEntities && !hasLongUrl) return src;

  const urls = [];
  const masked = src.replace(URL_RE, (m) => {
    urls.push(m);
    return `\u0000${urls.length - 1}\u0000`;
  });

  const withMentions = masked.replace(MENTION_RE, (_m, handle) => {
    return `[@${handle}](https://x.com/${handle})`;
  });

  const known = [...new Set((options.hashtags || []).filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );
  let withTags = withMentions;
  if (known.length) {
    // 用原文的标签边界；一次替换完，长标签排在前面优先匹配。
    // 逐个 replace 会互相嵌套：先替换 #愛美_星々の宴，再替换 #愛美 时会命中
    // 刚才生成的链接文字，产出 `[[#愛美](…)_星々の宴](…)` 这种坏结构。
    const alternation = known
      .map((tag) => tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|');
    const pattern = new RegExp(`(?<![\\w#@])#(?:${alternation})`, 'gu');
    withTags = withTags.replace(pattern, (m) => {
      const tag = m.slice(1);
      return `[#${tag}](https://x.com/hashtag/${encodeURIComponent(tag)})`;
    });
  } else {
    withTags = withTags.replace(HASHTAG_RE, (_m, tag) => {
      return `[#${tag}](https://x.com/hashtag/${encodeURIComponent(tag)})`;
    });
  }

  // 译文可能把标签里的字换掉（論→论、繁体→简体），精确匹配就会漏；
  // 再按「前后都是边界」兜一次底，避免像 #夜行性自论 这样整条标签没有链接。
  const guarded = [];
  const maskedLinks = withTags.replace(/\[[^\]\n]*\]\([^)\s]*\)/g, (m) => {
    guarded.push(m);
    return `\u0001${guarded.length - 1}\u0001`;
  });
  const withFallback = maskedLinks.replace(HASHTAG_BOUNDARY_RE, (_m, run) => {
    // 译文可能把标签里的字换掉（論→论），也可能让标签和后面的正文粘在一起。
    // resolveHashtagRun 会用原文标签表把「标签 + 剩余正文」切开。
    const { tag, rest } = resolveHashtagRun(run, known);
    if (!tag) return _m;
    return `[#${tag}](https://x.com/hashtag/${encodeURIComponent(tag)})${rest}`;
  });
  withTags = withFallback.replace(/\u0001(\d+)\u0001/g, (_m, i) => guarded[Number(i)] ?? '');

  return withTags.replace(/\u0000(\d+)\u0000/g, (_m, i) =>
    shortenLongUrls(urls[Number(i)] ?? '', limit),
  );
}

// 只由「横线类字符」组成的行会被当成分隔线（`---`），还会把**上一行**变成标题。
// 除了 ASCII，日文常用 ￣ ー ― — 和制表符 ─ ━ 等做分隔，这些也要挡住。
const RULE_CHARS = '\\-‒–—―﹣－ー￣_=*~─━═≡▬➖';
const RULE_RE = new RegExp(`^\\s*[${RULE_CHARS}]{2,}\\s*$`, 'u');

/**
 * 推文正文里以 Markdown 语法字符开头的行会被解析成标题/列表/引用，
 * 这里在行首插一个零宽空格阻断语法（肉眼不可见）。
 */
export function escapeMarkdownText(text) {
  return String(text || '')
    .split('\n')
    .map((line) => {
      // 行首 # 一律阻断（QQ 会把「#话题」当成标题加粗，即使后面没有空格）
      if (/^\s*#{1,6}/.test(line)) {
        return `\u200B${line}`;
      }
      // 分隔线（---、===、￣￣￣、ーーー…）：不挡会把上一行变成大字标题
      if (RULE_RE.test(line)) {
        return `\u200B${line}`;
      }
      if (/^\s*(>|[-*+]\s|\d+[.)]\s|`{3})/.test(line)) {
        return `\u200B${line}`;
      }
      return line;
    })
    .join('\n');
}

/** Markdown 卡片样式（模仿 QQ 推文卡片：头像+名字+徽章 / 正文 / 内嵌图 / 引用块页脚）。 */
export function formatTweetMarkdown(tweet, cfg, ctx = {}) {
  // 名字优先用推文自己的作者，配置里的 displayName 只做兜底
  const name = ctx.name || tweet.author || cfg.x.displayName || 'X';
  const header = ctx.header || {};
  const images = Array.isArray(ctx.images) ? ctx.images : ctx.image ? [ctx.image] : [];

  // 头像与名字之间两个空格；认证徽章离名字近一点（一个空格）
  // 主推名字用一级标题 + 加粗，是全卡最大的元素
  let head = '# ';
  if (header.avatar) head += `![头像 #32px #32px](${header.avatar})  `;
  head += `**${name}**`;
  if (header.badge) head += ` ![认证 #16px #19px](${header.badge})`;

  const lines = [];
  if (ctx.repost) {
    // 横幅只放「谁转的」；转推时间另起一行用引用块缩进，避免一行太长
    lines.push(`## **⇄ ${ctx.repost.name} 已转帖**`);
    if (ctx.repost.time) {
      lines.push(`> 转帖于 ${formatFooterTime(ctx.repost.time, cfg.forward.timeZone)}`);
    }
    lines.push('');
  }

  // 回复类型：名字下一行标「↩ 回复 + 被回复人的昵称」
  const replyTo = ctx.replyTo || tweet.replyTo || '';
  const isReplyLike = !ctx.repost && (tweet.isReply || Boolean(replyTo));

  if (isReplyLike) {
    // 自己回自己写「自己」；否则优先用被回复原推的作者昵称
    const selfReply = replyTo === '自己' || ctx.selfReply === true;
    const target = selfReply ? '自己' : ctx.replyContext?.name || replyTo;
    lines.push(head, target ? `**↩ 回复 ${target}**` : '**↩ 回复**', '');
  } else {
    lines.push(head, '');
  }

  if (tweet.isRetweet) lines.push('（转推）');

  const rawBody = tweet.text?.trim() || '';
  const originalBody = isReplyLike ? stripLeadingMentions(rawBody) : rawBody;
  const translatedText = String(ctx.translatedText || '').trim();
  const bodyText = translatedText || originalBody;
  if (bodyText) {
    // 标签边界取原文的：译文常把标签后面的空格吃掉，只看译文会把整句吞进链接
    lines.push(
      escapeMarkdownText(
        linkifyEntities(bodyText, {
          hashtags: extractHashtags(originalBody),
          longUrlChars: cfg.forward.longUrlChars,
        }),
      ),
    );
  }

  // 主推文配图：紧跟正文；多图之间不留空行（否则每张之间会有一道间隔）
  // QQ 的 Markdown 图片必须同时给宽高（#600px #400px），否则只显示 alt 文字
  const imagesBlocked = ctx.imagesBlocked === true;
  if (imagesBlocked) {
    // 图片被平台判违规：留一行文字标注，卡片排版照旧
    const n = Number(ctx.blockedImages) || 0;
    lines.push('', `> ⚠️ ${n > 0 ? `共 ${n} 张` : ''}配图因内容违规无法发送`);
  } else {
    images.forEach((img, index) => {
      if (!img?.url) return;
      const width = Math.round(img.width || 600);
      const height = Math.round(img.height || 400);
      // 有正文时图和正文之间空一行；纯图推文直接接在抬头下面，不留空行
      if (index === 0 && bodyText) lines.push('');
      lines.push(`![推文配图 #${width}px #${height}px](${img.url})`);
    });
  }

  // 图片「人物标记」：X 会显示成「某某 及另外 N 人」，贴在图片下面
  const photoTags = Array.isArray(ctx.photoTags) ? ctx.photoTags : [];
  if (photoTags.length && !imagesBlocked) {
    const first = photoTags[0]?.name || photoTags[0]?.screenName || '';
    if (first) {
      lines.push(photoTags.length > 1 ? `> ${first} 及另外${photoTags.length - 1}人` : `> ${first}`);
    }
  }

  // 外链卡片（比如 fanicon 的「New Post Available」）：X 会在图下面标来自哪个站点
  const cardSource = String(ctx.cardSource || '').trim();
  if (cardSource && !imagesBlocked) lines.push(`> 来自 ${cardSource}`);

  // 图片 / 视频放不进卡片时，卡片里留一行提示，稍后单独发
  const extras = [];
  if (ctx.videoCount > 0) extras.push(`🎬 视频共 ${ctx.videoCount} 段`);
  if (ctx.imageCount > 0 && !imagesBlocked) extras.push(`🖼 图片共 ${ctx.imageCount} 张`);
  if (extras.length) {
    lines.push('', `> ${extras.join('，')}，见下条消息`);
  }

  // 引用推文、被回复的原推都用 > 缩进，和主推区分开
  const blocks = [
    { block: ctx.replyContext, indent: true },
    { block: ctx.quote, indent: true },
  ].filter((x) => x.block);

  for (const { block: quote, indent } of blocks) {
    const qheadParts = [];
    if (quote.avatar) qheadParts.push(`![头像 #24px #24px](${quote.avatar})  `);
    // 引用推文 / 被回复原推的账号名：二级标题，和主推名字一样不加粗
    const qhead =
      '## ' +
      qheadParts.join('') +
      (quote.name || '引用推文') +
      (quote.badge ? ` ![认证 #14px #16px](${quote.badge})` : '');
    const inner = [qhead];
    // 引用推文 / 被回复的原推在开启翻译时也显示译文
    let quoteText = quote.text || '';
    if (quote === ctx.quote && ctx.translatedQuoteText) {
      quoteText = String(ctx.translatedQuoteText);
    } else if (quote === ctx.replyContext && ctx.translatedReplyText) {
      quoteText = String(ctx.translatedReplyText);
    }
    // X 长文（Article）：正文只有一条 article 链接，改成「标题 + 摘要」，和 X 上一样
    const article = quote.article;
    let articleLines = null;
    if (article?.title) {
      articleLines = [`**${article.title}**`];
      const excerpt = String(article.previewText || '').replace(/\s*\n\s*/g, '\n').trim();
      if (excerpt) {
        const clipped = excerpt.length > ARTICLE_EXCERPT_CHARS;
        const chars = Math.min(excerpt.length, ARTICLE_EXCERPT_CHARS);
        articleLines.push('', truncate(excerpt, ARTICLE_EXCERPT_CHARS));
        // X 的长文接口只给 preview_text（本身就是节选），全文拿不到；
        // 所以只要引用了长文，就说明我们只转发了前面这部分
        articleLines.push(
          '',
          clipped
            ? `字数过多，仅转发前 ${chars} 字`
            : `长文仅节选前 ${chars} 字，全文见原帖`,
        );
      }
    }
    if (articleLines) {
      inner.push('');
      for (const line of articleLines) {
        for (const part of escapeMarkdownText(line).split('\n')) inner.push(part);
      }
    } else if (quoteText) {
      inner.push('');
      for (const line of escapeMarkdownText(
        linkifyEntities(quoteText, {
          hashtags: extractHashtags(quote.text),
          longUrlChars: cfg.forward.longUrlChars,
        }),
      ).split('\n')) {
        inner.push(line);
      }
    }
    (quote.images || []).forEach((img, index) => {
      if (!img?.url) return;
      if (index === 0) inner.push('');
      inner.push(
        `![引用配图 #${Math.round(img.width || 520)}px #${Math.round(img.height || 300)}px](${img.url})`,
      );
    });
    // 引用块里的图也可能标了人，同样放在图下面
    const qTags = Array.isArray(quote.photoTags) ? quote.photoTags : [];
    if (qTags.length) {
      const first = qTags[0]?.name || qTags[0]?.screenName || '';
      if (first) {
        inner.push(qTags.length > 1 ? `${first} 及另外${qTags.length - 1}人` : first);
      }
    }
    // 引用块里的外链卡片
    const qCard = String(quote.cardSource || '').trim();
    if (qCard) inner.push(`来自 ${qCard}`);
    // 引用推文里的视频：和主推文一样，卡片里留提示，视频单独一条消息
    const qVideoCount = (Array.isArray(quote.videos) ? quote.videos.length : 0) + (quote.videoUrl ? 1 : 0);
    if (qVideoCount === 1) inner.push('🎬 视频共 1 段，见下条消息');
    else if (qVideoCount > 1) inner.push(`🎬 视频共 ${qVideoCount} 段，见下条消息`);
    const qmeta = [];
    if (quote.time) qmeta.push(formatFooterTime(new Date(quote.time), cfg.forward.timeZone));
    const qlink = quote.article?.url || quote.link || '';
    if (qlink) qmeta.push(`[查看原帖 ↗](${qlink})`);
    if (qmeta.length) {
      inner.push('');
      inner.push(qmeta.join('｜'));
    }

    lines.push('');
    for (const line of inner) {
      if (!indent) {
        lines.push(line);
      } else {
        lines.push(line ? `> ${line}` : '>');
      }
    }
  }

  // 页脚压成一行：一律用「推文本身的发布时间」，与 X 页面上显示的一致。
  // 转推时卡片展示的是原推内容，X 上也显示原推时间，所以不再用转推时间。
  if (translatedText) {
    // 紧贴在时间行上方，不缩进、不隔空行；走大模型时显示模型名，否则沿用 X 的措辞
    const by = String(ctx.translateBy || '').trim();
    lines.push('', by && by !== 'X' ? `由${by}翻译` : '由X自动翻译');
  }

  const meta = [];
  const stamp = tweet.published || ctx.repost?.time;
  if (stamp) meta.push(formatFooterTime(stamp, cfg.forward.timeZone));
  if (cfg.forward.includeLink !== false && tweet.link) {
    meta.push(`[查看原帖 ↗](${tweet.link})`);
  }
  if (meta.length) {
    // 翻译标记已经自带空行，这里不再重复空一行，让标记紧贴时间行
    if (!translatedText) lines.push('');
    lines.push(meta.join('｜'));
  }

  return truncateMarkdown(lines.join('\n'), cfg.forward.maxMarkdownChars ?? 4000);
}
