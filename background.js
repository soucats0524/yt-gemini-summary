import { GEMINI_API_KEY } from './config.js';
const MENU_ID = 'yt-gemini-scribe-summarize';

// 1. コンテキストメニューの初期化
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: 'この動画を要約して保存',
    contexts: ['link'],
    targetUrlPatterns: ['*://*.youtube.com/watch*']
  });
});

// 2. メイン処理のトリガー
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
if (info.menuItemId !== MENU_ID) return;
const videoUrl = info.linkUrl;
const newTab = await chrome.tabs.create({ url: videoUrl, active: false });

notify('処理開始', '字幕の抽出を開始します。');

let tempTabId = null;
try {
    // タブのロード完了を待機
    await new Promise((resolve) => {
      chrome.tabs.onUpdated.addListener(function listener(tabId, changeInfo) {
        if (tabId === newTab.id && changeInfo.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          tempTabId = tabId;
          resolve();
        }
      });
    });

    // ロード完了後にスクリプトを注入
    const results = await chrome.scripting.executeScript({
      target: { tabId: newTab.id },
      world: "MAIN",
      func: extractSubtitlesFromPage // 定義済みの抽出関数を直接指定
    });

    const extractionResult = results[0].result;
    if (!extractionResult || !extractionResult.success) {
      console.error("字幕データ抽出失敗:", extractionResult?.reason || "不明なエラー");
      return;
    }

    const transcript = extractionResult.text;
    if (!results || !transcript) {
      console.error("字幕データが見つかりませんでした。");
      return;
    }
    
    // 不要になったタブを閉じる
    await chrome.tabs.remove(tempTabId);
    tempTabId = null;

    notify('要約生成中', 'Gemini APIにデータを送信しています。');

    // 5. Gemini APIによる要約
    const summary = await generateSummary(transcript);

    // 6. Markdownファイルとしてダウンロード
    await downloadAsMarkdown(summary, `summary_${Date.now()}.md`);

    notify('処理完了', '要約をMarkdownとして保存しました。');

  } catch (error) {
    console.error(error);
    notify('エラー', error.message || '処理中にエラーが発生しました。');
    if (tempTabId) chrome.tabs.remove(tempTabId).catch(() => {});
  }
});

// --- ユーティリティ関数 ---

// タブのロード完了を待機するPromiseラッパー
function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.onUpdated.addListener(function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    });
  });
}

// ページコンテキスト（MAIN world）で実行される抽出ロジック（デバッグ強化版）
async function extractSubtitlesFromPage() {
  try {
    const playerResponse = window.ytInitialPlayerResponse;
    if (!playerResponse) return { success: false, reason: "window.ytInitialPlayerResponse is undefined." };

    const tracks = playerResponse.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!tracks || tracks.length === 0) return { success: false, reason: "No caption tracks found." };

    const baseUrl = tracks[0].baseUrl;
    const response = await fetch(baseUrl, { credentials: 'include' });
    if (!response.ok) return { success: false, reason: `Fetch failed: ${response.status}` };

    const rawText = await response.text();
    let cleanText = "";

    const trimmedText = rawText.trim();
    if (trimmedText.startsWith('{') || trimmedText.startsWith('[')) {
      try {
        const jsonData = JSON.parse(rawText);
        const events = jsonData.events || [];
        cleanText = events
          .filter(event => event.segs)
          .map(event => event.segs.map(seg => seg.utf8).join(''))
          .join(' ')
          .trim();
      } catch (e) {
        return { success: false, reason: `JSON parse error: ${e.message}` };
      }
    } else {
      // XML形式としての処理（タグ名が異なる可能性を考慮し、全体をプレビュー出力できるようにする）
      const matches = [...rawText.matchAll(/<text[^>]*>(.*?)<\/text>/g)];
      if (matches.length === 0) {
        // レスポンスの実態を把握するため、先頭100文字をエラー理由に含めて返却
        const preview = rawText.slice(0, 100).replace(/\s+/g, ' ');
        return { success: false, reason: `No <text> elements found. Preview: ${preview}` };
      }

      cleanText = matches
        .map(m => m[1])
        .join(' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    }

    if (!cleanText) {
      return { success: false, reason: "字幕テキストが空です。" };
    }

    return { success: true, text: cleanText };
  } catch (err) {
    return { success: false, reason: `Exception: ${err.message}` };
  }
}

// Gemini APIの呼び出し
async function generateSummary(text) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${GEMINI_API_KEY}`;
  
  const payload = {
    contents: [{
      parts: [{
        text: `以下の動画の字幕を詳細に要約し、Markdown形式で見出しや箇条書きを用いて構造化して出力してください。\n\n${text}`
      }]
    }]
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`Gemini API Error: ${response.status}`);
  }

  const data = await response.json();
  return data.candidates[0].content.parts[0].text;
}

// ダウンロード処理（Service Workerの制約回避）
async function downloadAsMarkdown(content, filename) {
  // Service Workerでは URL.createObjectURL(Blob) が使用できないため Data URI を使用
  const dataUrl = 'data:text/markdown;charset=utf-8,' + encodeURIComponent(content);
  await chrome.downloads.download({
    url: dataUrl,
    filename: filename,
    saveAs: false
  });
}

// 通知処理
function notify(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon48.png', // manifest.jsonで指定したパスと一致させること
    title: title,
    message: message
  });
}