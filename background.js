import { GEMINI_API_KEY } from './config.js';

const HOST_NAME = "com.yt_gemini_scribe.host";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "yt-gemini-scribe-menu",
    title: "この動画の字幕をGeminiで要約",
    contexts: ["page", "link"],
    documentUrlPatterns: ["https://www.youtube.com/watch*"]
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "yt-gemini-scribe-menu" && tab.id) {
    try {
      // 1. メタデータの取得 (ページコンテキストで実行)
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: extractMetadata
      });

      const videoData = results[0]?.result;
      if (!videoData) throw new Error("メタデータの抽出に失敗した。");

      // 2. Pythonスクリプトへの通信 (Native Messaging)
      console.log("Pythonホストへ字幕取得を要求中...");
      const hostResponse = await chrome.runtime.sendNativeMessage(HOST_NAME, { url: videoData.url });

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

// メタデータのみを取得する関数 (字幕抽出処理は除外)
async function extractMetadata() {
  const playerResponse = window.ytInitialPlayerResponse || 
                         JSON.parse(document.querySelector('script#ytInitialPlayerResponse')?.textContent || '{}');
  const details = playerResponse.videoDetails || {};
  return {
    title: details.title || document.title.replace(/ - YouTube$/, ''),
    description: details.shortDescription || "",
    thumbnail: details.thumbnail?.thumbnails?.pop()?.url || "",
    url: window.location.href
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