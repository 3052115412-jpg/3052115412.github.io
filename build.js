/**
 * Blog Builder — converts Markdown notes into a beautiful static blog
 *
 * Usage: node build.js
 *   Reads notes from ../n/ (all directories)
 *   Generates HTML to ./posts/ + ./index.html
 */

const fs = require('fs');
const path = require('path');

// ─── Configuration ──────────────────────────────────────────────
const NOTES_DIR = 'F:/notes/my-personal-notes/n';
const OUTPUT_DIR = __dirname;
const POSTS_DIR = path.join(OUTPUT_DIR, 'posts');
const SITE_TITLE = '📒 笔记博客';
const SITE_DESC = '数据结构 · Web安全 · CTF · 效率工具';

// Category mapping: folder → { name, icon, emoji }
const CATEGORIES = {
    '基本':     { name: '电脑技巧',   emoji: '🖥️', slug: 'basic' },
    '数据结构': { name: '数据结构',   emoji: '📊', slug: 'ds' },
    'web基础':  { name: 'Web 基础',   emoji: '🌐', slug: 'web' },
    'pikachu':  { name: 'Pikachu靶场',emoji: '🎯', slug: 'pikachu' },
    'ctfshow web': { name: 'CTF 刷题',emoji: '🚩', slug: 'ctfshow' },
};

// Files to skip
const SKIP_FILES = ['README.md', 'sync_notes.bat'];

// ─── Utility ────────────────────────────────────────────────────
function esc(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function slugify(name) {
    return name.replace(/\.[^/.]+$/, '')  // remove ext
        .replace(/[^a-zA-Z0-9一-鿿\-_]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '') || 'untitled';
}

function excerpt(text, len) {
    return text.replace(/\s+/g, ' ').trim().slice(0, len) + (text.length > len ? '…' : '');
}

function getCategory(filePath) {
    const rel = path.relative(NOTES_DIR, filePath);
    for (const [key, val] of Object.entries(CATEGORIES)) {
        if (rel.startsWith(key + path.sep) || rel.startsWith(key + '/')) return val;
    }
    return { name: '其他', emoji: '📄', slug: 'other' };
}

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ─── Markdown Parser ────────────────────────────────────────────
function parseMD(raw) {
    // Normalize line endings
    raw = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const footnotes = {};
    const fnDefRegex = /^\[\^([^\]]+)\]:\s*(.+)$/gm;
    let m;
    while ((m = fnDefRegex.exec(raw)) !== null) {
        footnotes[m[1]] = m[2].trim();
    }
    raw = raw.replace(fnDefRegex, '');

    // Split into blocks
    const blocks = [];
    let inCodeBlock = false;
    let codeLang = '';
    let codeBuf = [];
    let paraBuf = [];

    function flushPara() {
        const p = paraBuf.join('\n').trim();
        if (p) blocks.push({ type: 'raw', text: p });
        paraBuf = [];
    }

    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Fenced code block
        if (/^```/.test(line)) {
            flushPara();
            if (!inCodeBlock) {
                inCodeBlock = true;
                codeLang = line.slice(3).trim();
                codeBuf = [];
            } else {
                blocks.push({ type: 'code', lang: codeLang, code: codeBuf.join('\n') });
                inCodeBlock = false;
                codeLang = '';
                codeBuf = [];
            }
            continue;
        }
        if (inCodeBlock) { codeBuf.push(line); continue; }

        // HR
        if (/^---\s*$/.test(line)) { flushPara(); blocks.push({ type: 'hr' }); continue; }

        // Table (detect: has | and next line has |---|)
        if (line.includes('|') && i + 1 < lines.length && /^\|?[\s\-:|]+\|?$/.test(lines[i+1])) {
            flushPara();
            const headerCells = line.split('|').filter(c => c.trim()).map(c => c.trim());
            const alignLine = lines[i+1];
            const aligns = alignLine.split('|').filter(c => c.trim()).map(c => {
                if (c.startsWith(':') && c.endsWith(':')) return 'center';
                if (c.endsWith(':')) return 'right';
                return 'left';
            });
            const rows = [];
            i += 2; // skip separator
            while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
                rows.push(lines[i].split('|').filter(c => c.trim()).map(c => c.trim()));
                i++;
            }
            i--;
            blocks.push({ type: 'table', header: headerCells, aligns, rows });
            continue;
        }

        // Blank line
        if (line.trim() === '') { flushPara(); blocks.push({ type: 'blank' }); continue; }

        paraBuf.push(line);
    }
    flushPara();

    // Process raw blocks into typed blocks
    const typedBlocks = [];
    for (const block of blocks) {
        if (block.type !== 'raw') { typedBlocks.push(block); continue; }

        const text = block.text;
        // Heading
        const hMatch = text.match(/^(#{1,6})\s+(.+)$/m);
        if (hMatch) {
            typedBlocks.push({ type: 'heading', level: hMatch[1].length, text: hMatch[2] });
            continue;
        }
        // Blockquote
        if (/^>\s/.test(text)) {
            const lines2 = text.split('\n').map(l => l.replace(/^>\s?/, '')).join('\n');
            typedBlocks.push({ type: 'blockquote', children: parseInline(lines2) });
            continue;
        }
        // Ordered list
        if (/^\d+\.\s/.test(text)) {
            typedBlocks.push({ type: 'ol', items: parseListItems(text, /^\d+\.\s/) });
            continue;
        }
        // Unordered list
        if (/^[\*\-\+]\s/.test(text)) {
            typedBlocks.push({ type: 'ul', items: parseListItems(text, /^[\*\-\+]\s/) });
            continue;
        }
        // Plain paragraph
        typedBlocks.push({ type: 'paragraph', text: parseInline(text) });
    }

    return { blocks: typedBlocks, footnotes };
}

function parseListItems(text, regex) {
    const items = [];
    let current = [];
    const lines = text.split('\n');
    for (const line of lines) {
        if (regex.test(line)) {
            if (current.length) items.push(current.join('\n'));
            current = [line.replace(regex, '')];
        } else if (line.trim()) {
            current.push(line);
        }
    }
    if (current.length) items.push(current.join('\n'));
    return items.map(item => parseInline(item.trim()));
}

function parseInline(text) {
    if (!text) return '';
    let html = esc(text);

    // Handle HTML <img> tags before other processing
    html = html.replace(/&lt;img\s+src="([^"]+)"[^&]*\/?&gt;/gi, (m, src) => {
        if (/^[A-Za-z]:\\/.test(src) || src.includes('typora-user-images')) {
            return '<span class="missing-img" title="' + esc(src) + '">📷 [图片]</span>';
        }
        return '<img src="' + src + '" loading="lazy">';
    });

    // Protect markdown images first
    const imgs = [];
    html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, alt, src) => {
        imgs.push({ alt: esc(alt), src });
        return `__IMG_${imgs.length - 1}__`;
    });
    // Links
    const links = [];
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, txt, url) => {
        if (/^https?:\/\//.test(url)) {
            links.push({ txt: esc(txt), url });
            return `__LINK_${links.length - 1}__`;
        }
        // Internal/wiki link [[page]]
        const slug = slugify(txt);
        links.push({ txt: esc(txt), url: `posts/${slug}.html` });
        return `__LINK_${links.length - 1}__`;
    });

    // Bold
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // Italic
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    // Highlight
    html = html.replace(/==(.+?)==/g, '<mark>$1</mark>');
    // Subscript ~
    html = html.replace(/~([^~]+)~/g, '<sub>$1</sub>');
    // Superscript ^
    html = html.replace(/\^([^^\s]+)\^/g, '<sup>$1</sup>');
    // Underline <u>
    html = html.replace(/<u>(.+?)<\/u>/gi, '<u>$1</u>');
    // Strikethrough ~~
    html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');

    // Footnotes [^note]
    html = html.replace(/\[\^([^\]]+)\]/g, (m, key) =>
        `<sup class="footnote-ref"><a href="#fn-${key}" id="fnref-${key}">[${key}]</a></sup>`);

    // Restore images and links (skip broken local paths)
    imgs.forEach((img, i) => {
        const src = img.src;
        const isLocal = /^[A-Za-z]:\\/.test(src) || src.includes('typora-user-images');
        const tag = isLocal
            ? `<span class="missing-img" title="${esc(src)}">📷 [图片: ${img.alt || '未命名'}]</span>`
            : `<img src="${src}" alt="${img.alt}" loading="lazy">`;
        html = html.replace(`__IMG_${i}__`, tag);
    });
    links.forEach((link, i) => {
        html = html.replace(`__LINK_${i}__`,
            `<a href="${link.url}" target="_blank" rel="noopener">${link.txt}</a>`);
    });

    // Checkbox
    html = html.replace(/\[x\]/gi, '<input type="checkbox" checked disabled>');
    html = html.replace(/\[ \]/g, '<input type="checkbox" disabled>');

    return html;
}

function renderBlocks(blocks) {
    let out = '';
    for (const b of blocks) {
        switch (b.type) {
            case 'heading':
                out += `<h${b.level}>${b.text}</h${b.level}>\n`;
                break;
            case 'paragraph':
                out += `<p>${b.text}</p>\n`;
                break;
            case 'code':
                const lang = b.lang ? ` class="language-${esc(b.lang)}"` : '';
                out += `<pre><code${lang}>${esc(b.code)}</code></pre>\n`;
                break;
            case 'hr':
                out += `<hr>\n`;
                break;
            case 'blockquote':
                out += `<blockquote>${b.children}</blockquote>\n`;
                break;
            case 'ul':
                out += '<ul>\n' + b.items.map(i => `<li>${i}</li>`).join('\n') + '\n</ul>\n';
                break;
            case 'ol':
                out += '<ol>\n' + b.items.map(i => `<li>${i}</li>`).join('\n') + '\n</ol>\n';
                break;
            case 'table':
                out += '<table>\n<thead>\n<tr>\n' +
                    b.header.map((h, i) => `<th${b.aligns[i] ? ` style="text-align:${b.aligns[i]}"` : ''}>${h}</th>`).join('\n') +
                    '\n</tr>\n</thead>\n<tbody>\n' +
                    b.rows.map(r => '<tr>\n' + r.map((c, j) =>
                        `<td${b.aligns[j] ? ` style="text-align:${b.aligns[j]}"` : ''}>${c}</td>`
                    ).join('\n') + '\n</tr>').join('\n') +
                    '\n</tbody>\n</table>\n';
                break;
            case 'blank':
                // skip
                break;
        }
    }
    return out;
}

function renderFootnotes(footnotes) {
    if (!Object.keys(footnotes).length) return '';
    let out = '<div class="footnotes"><hr><ol>\n';
    for (const [key, val] of Object.entries(footnotes)) {
        out += `<li id="fn-${key}">${val} <a href="#fnref-${key}">↩</a></li>\n`;
    }
    out += '</ol></div>\n';
    return out;
}

// ─── HTML Templates ─────────────────────────────────────────────
function pageTemplate(title, body, depth, extraHead) {
    const prefix = depth === 0 ? '.' : '../'.repeat(depth);
    const cssPath = prefix + 'css/style.css';
    const homePath = prefix + 'index.html';
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)} — ${SITE_TITLE}</title>
<link rel="stylesheet" href="${cssPath}">
${extraHead || ''}
</head>
<body>
<nav class="nav">
  <div class="container">
    <a href="${homePath}" class="nav-brand"><span class="icon">N</span> 笔记博客</a>
    <ul class="nav-links">
      <li><a href="${homePath}">首页</a></li>
      ${Object.values(CATEGORIES).map(c =>
        `<li><a href="${homePath}#cat-${c.slug}">${c.emoji} ${c.name}</a></li>`
      ).join('\n      ')}
    </ul>
  </div>
</nav>
<main class="container">
  <div class="post-page">
    <a href="${homePath}" class="back-link">← 返回首页</a>
    ${body}
  </div>
</main>
<footer class="footer">
  <div class="container">
    <p>📒 个人学习笔记 · Powered by plain HTML & CSS</p>
  </div>
</footer>
</body>
</html>`;
}

// ─── Generate Post Pages ────────────────────────────────────────
const allPosts = [];

function buildPost(mdPath) {
    const fname = path.basename(mdPath);
    let raw = fs.readFileSync(mdPath, 'utf-8');

    // Skip explicitly excluded files
    if (SKIP_FILES.includes(fname)) { console.log(`  ⏭️  SKIP: ${fname}`); return; }

    // Parse YAML frontmatter (---\r?\nkey: val\r?\n---)
    let displayTitle = fname.replace(/\.md$/, '');
    const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
    if (fmMatch) {
        const fm = fmMatch[1];
        raw = raw.slice(fmMatch[0].length); // strip frontmatter for parsing
        const titleMatch = fm.match(/^title:\s*(.+)$/m);
        if (titleMatch) displayTitle = titleMatch[1].trim().replace(/["']/g, '');
    }

    const slug = slugify(displayTitle);
    const cat = getCategory(mdPath);

    const parsed = parseMD(raw);
    const contentHTML = renderBlocks(parsed.blocks) + renderFootnotes(parsed.footnotes);

    // Extract excerpt
    const plain = raw.replace(/#+\s+/g, '').replace(/```[\s\S]*?```/g, '').replace(/\[.+?\]/g, '');

    const postHTML = pageTemplate(displayTitle, `
    <article>
      <header class="post-header">
        <span class="post-cat">${cat.emoji} ${cat.name}</span>
        <h1>${esc(displayTitle)}</h1>
        <div class="post-meta">
          <span>📁 ${cat.name}</span>
          <span>📄 ${raw.split('\n').length} 行</span>
        </div>
      </header>
      <div class="post-content">
        ${contentHTML}
      </div>
    </article>`, 2); // depth=2: posts/<cat>/<file>.html

    // Write post
    const catDir = path.join(POSTS_DIR, cat.slug);
    ensureDir(catDir);
    const outPath = path.join(catDir, slug + '.html');
    fs.writeFileSync(outPath, postHTML, 'utf-8');

    const excerptText = excerpt(plain, 120);
    allPosts.push({ title: displayTitle, slug, cat, fname, excerpt: excerptText, path: `posts/${cat.slug}/${slug}.html` });

    console.log(`  ✅ ${cat.emoji} ${displayTitle}`);
}

// ─── Generate Index ─────────────────────────────────────────────
function buildIndex() {
    // Group by category
    const grouped = {};
    for (const p of allPosts) {
        if (!grouped[p.cat.slug]) grouped[p.cat.slug] = { cat: p.cat, posts: [] };
        grouped[p.cat.slug].posts.push(p);
    }

    // Build post cards HTML
    let cardsHTML = '';
    for (const [slug, group] of Object.entries(grouped)) {
        cardsHTML += `<section id="cat-${slug}" style="margin-bottom: 40px;">`;
        cardsHTML += `<h2 style="font-size: 1.4rem; font-weight: 700; margin-bottom: 16px; display: flex; align-items: center; gap: 8px;">
            ${group.cat.emoji} ${group.cat.name}
            <span style="font-size: 0.8rem; color: var(--text-lighter); font-weight: 400;">${group.posts.length} 篇</span>
        </h2>`;
        cardsHTML += `<div class="post-grid">`;
        for (const p of group.posts) {
            cardsHTML += `
            <a href="${p.path}" class="post-card">
                <span class="card-cat">${p.cat.emoji} ${p.cat.name}</span>
                <h3>${esc(p.title)}</h3>
                <p>${esc(p.excerpt)}</p>
                <div class="card-meta">📄 ${p.fname}</div>
            </a>`;
        }
        cardsHTML += `</div></section>`;
    }

    const indexHTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${SITE_TITLE}</title>
<meta name="description" content="${SITE_DESC}">
<link rel="stylesheet" href="css/style.css">
</head>
<body>
<nav class="nav">
  <div class="container">
    <a href="index.html" class="nav-brand"><span class="icon">N</span> 笔记博客</a>
    <ul class="nav-links">
      <li><a href="index.html" class="active">首页</a></li>
      ${Object.values(CATEGORIES).map(c =>
        `<li><a href="#cat-${c.slug}">${c.emoji} ${c.name}</a></li>`
      ).join('\n      ')}
    </ul>
  </div>
</nav>
<main class="container">
  <section class="hero">
    <h1>📒 个人笔记博客</h1>
    <p>${SITE_DESC}</p>
    <div class="hero-stats">
      <div class="stat"><span class="stat-num">${allPosts.length}</span><span class="stat-label">篇笔记</span></div>
      <div class="stat"><span class="stat-num">${Object.keys(grouped).length}</span><span class="stat-label">个分类</span></div>
    </div>
  </section>

  <div class="search-wrap">
    <span class="search-icon">🔍</span>
    <input type="text" class="search-input" id="searchBox" placeholder="搜索笔记..." autocomplete="off">
  </div>

  <div class="categories">
    <button class="cat-btn active" data-cat="all">全部</button>
    ${Object.values(CATEGORIES).map(c =>
      `<button class="cat-btn" data-cat="${c.slug}">${c.emoji} ${c.name}</button>`
    ).join('\n    ')}
  </div>

  <div id="postContainer">
    ${cardsHTML}
  </div>

  <div class="empty-state" id="noResults" style="display:none;">
    <div class="icon">🔍</div>
    <p>没有找到匹配的笔记</p>
  </div>
</main>
<footer class="footer">
  <div class="container">
    <p>📒 个人学习笔记 · 最后更新 ${new Date().toLocaleDateString('zh-CN')}</p>
  </div>
</footer>
<script>
// Search
const searchBox = document.getElementById('searchBox');
const cards = document.querySelectorAll('.post-card');
const sections = document.querySelectorAll('[id^="cat-"]');
const noResults = document.getElementById('noResults');
searchBox.addEventListener('input', function() {
    const q = this.value.toLowerCase();
    let foundAny = false;
    cards.forEach(c => {
        const text = c.textContent.toLowerCase();
        const match = !q || text.includes(q);
        c.style.display = match ? '' : 'none';
        if (match) foundAny = true;
    });
    sections.forEach(s => {
        const vis = s.querySelectorAll('.post-card[style*="display: none"], .post-card[style=""]');
        const hasVisible = Array.from(s.querySelectorAll('.post-card')).some(cc => cc.style.display !== 'none');
        s.style.display = hasVisible ? '' : 'none';
    });
    noResults.style.display = foundAny || q === '' ? 'none' : '';
});

// Category filter
const catBtns = document.querySelectorAll('.cat-btn');
catBtns.forEach(btn => {
    btn.addEventListener('click', function() {
        catBtns.forEach(b => b.classList.remove('active'));
        this.classList.add('active');
        const cat = this.dataset.cat;
        sections.forEach(s => {
            s.style.display = (cat === 'all' || s.id === 'cat-' + cat) ? '' : 'none';
        });
        searchBox.value = '';
        cards.forEach(c => c.style.display = '');
        noResults.style.display = 'none';
    });
});
</script>
</body>
</html>`;

    fs.writeFileSync(path.join(OUTPUT_DIR, 'index.html'), indexHTML, 'utf-8');
    console.log(`\n  🏠 index.html generated (${allPosts.length} posts)`);
}

// ─── Main ───────────────────────────────────────────────────────
function walk(dir, callback) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory() && !e.name.startsWith('.') && !e.name.endsWith('.assets')) {
            walk(full, callback);
        } else if (e.isFile() && e.name.endsWith('.md')) {
            callback(full);
        }
    }
}

console.log('🔨 Building blog...\n');
console.log('📝 Generating posts:\n');

// Clear posts dir
if (fs.existsSync(POSTS_DIR)) {
    fs.rmSync(POSTS_DIR, { recursive: true });
}
ensureDir(POSTS_DIR);

walk(NOTES_DIR, buildPost);

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━\n');
buildIndex();
console.log('\n✅ Blog built successfully!');
console.log(`   Open: file:///${OUTPUT_DIR.replace(/\\/g, '/')}/index.html`);
