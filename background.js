import { GEMINI_API_KEY } from './config.js';

const HOST_NAME = "com.yt_gemini_scribe.host";

// コンテキストメニューの初期化
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "yt-gemini-scribe-menu",
    title: "この動画リンクをGeminiで要約",
    contexts: ["page", "link"],
    // トップページ（おすすめ一覧）等でもメニューを表示させるため条件を緩和
    documentUrlPatterns: ["https://www.youtube.com/*"]
  });
});

// メイン処理のトリガー
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "yt-gemini-scribe-menu") {
    try {
      // リンク上での右クリック時は linkUrl、動画ページ上での右クリック時は pageUrl を取得
      const targetUrl = info.linkUrl || info.pageUrl;

      if (!targetUrl || (!targetUrl.includes('watch?v=') && !targetUrl.includes('youtu.be/'))) {
        throw new Error("有効なYouTubeの動画リンクではない。");
      }

      console.log("動画メタデータを取得中:", targetUrl);
      
      // 1. メタデータの取得 (バックグラウンドでHTMLフェッチ)
      const videoData = await fetchMetadataFromHtml(targetUrl);

      // 2. Pythonホストへの通信 (Native Messaging)
      console.log("Pythonホストへ字幕取得を要求中...");
      const hostResponse = await chrome.runtime.sendNativeMessage(HOST_NAME, { url: targetUrl });

      if (!hostResponse || !hostResponse.success) {
        throw new Error(hostResponse?.error || "Pythonホストでの字幕取得に失敗した。");
      }

      console.log("字幕抽出成功。Gemini APIへ送信中...");

      // 3. 要約と保存
      const summary = await summarizeWithGemini(hostResponse.transcript);
      await generateAndDownloadMarkdown(videoData, summary);

    } catch (error) {
      console.error("処理エラー:", error);
    }
  }
});

// --- メタデータ抽出ロジック（DOM非依存） ---
async function fetchMetadataFromHtml(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`動画ページの取得に失敗した (HTTP ${response.status})`);
  }
  const html = await response.text();

  // OGPタグ（Open Graph Protocol）からメタデータを正規表現で抽出
  const titleMatch = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i) || html.match(/<meta\s+name="title"\s+content="([^"]+)"/i);
  const descMatch = html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i) || html.match(/<meta\s+name="description"\s+content="([^"]+)"/i);
  const thumbMatch = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);

  // HTMLエンティティ（&amp; 等）をデコード
  const decodeEntities = (str) => {
     if (!str) return "";
     return str.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  };

  return {
    title: decodeEntities(titleMatch ? titleMatch[1] : "Unknown Title"),
    description: decodeEntities(descMatch ? descMatch[1] : ""),
    thumbnail: thumbMatch ? thumbMatch[1] : "",
    url: url
  };
}

// --- ユーティリティ関数 ---
async function summarizeWithGemini(transcript) {
  const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`;
  
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: `以下の字幕を要約せよ:\n\n${transcript}` }] }] })
  });

  if (!response.ok) throw new Error("Gemini API通信エラー");
  const data = await response.json();
  return data.candidates[0].content.parts[0].text;
}

async function generateAndDownloadMarkdown(videoData, summary) {
  const cleanDescription = (videoData.description || "").replace(/\r?\n/g, ' ').replace(/"/g, '\\"').substring(0, 150);
  const cardLink = [
    "```cardlink",
    `url: ${videoData.url}`,
    `title: "${videoData.title.replace(/"/g, '\\"')}"`,
    `description: "${cleanDescription}..."`,
    `image: ${videoData.thumbnail}`,
    "```",
    ""
  ].join("\n");

  const markdownContent = `${cardLink}\n\n# 要約\n\n${summary}`;
  const dataUrl = 'data:text/markdown;charset=utf-8,' + encodeURIComponent(markdownContent);
  await chrome.downloads.download({
    url: dataUrl,
    filename: `${videoData.title.replace(/[\\/:*?"<>|]/g, '_')}.md`,
    saveAs: false
  });
}