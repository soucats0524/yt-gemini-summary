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

  notify('処理開始', '字幕の抽出を開始します。');

  let tempTabId = null;
  try {
    // 3. 非アクティブタブの生成と読み込み待機
    const tempTab = await chrome.tabs.create({ url: videoUrl, active: false });
    tempTabId = tempTab.id;
    await waitForTabLoad(tempTabId);

    // 4. スクリプト注入による字幕取得
    const injectionResult = await chrome.scripting.executeScript({
      target: { tabId: tempTabId },
      world: 'MAIN', // window.ytInitialPlayerResponse にアクセスするために必須
      func: extractSubtitlesFromPage
    });

    const transcript = injectionResult[0].result;
    if (!transcript) {
      throw new Error('字幕データが見つかりませんでした。');
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

// ページコンテキスト（MAIN world）で実行される抽出ロジック
// 戻り値は呼び出し元の Service Worker に渡される
async function extractSubtitlesFromPage() {
  try {
    const playerResponse = window.ytInitialPlayerResponse;
    if (!playerResponse) return null;

    const tracks = playerResponse.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!tracks || tracks.length === 0) return null;

    // 最初の字幕（通常は自動生成またはアップロードされたもの）のURLを取得
    const baseUrl = tracks[0].baseUrl;
    
    const response = await fetch(baseUrl);
    const xmlText = await response.text();

    // 簡易的なXMLタグ除去（最小構成のため単純な正規表現を使用）
    const cleanText = xmlText
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim();

    return cleanText;
  } catch (err) {
    return null;
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