import sys
import json
import struct
import re
from youtube_transcript_api import YouTubeTranscriptApi
from youtube_transcript_api.formatters import TextFormatter

def get_message():
    raw_length = sys.stdin.buffer.read(4)
    if len(raw_length) == 0:
        sys.exit(0)
    msg_length = struct.unpack('@I', raw_length)[0]
    message = sys.stdin.buffer.read(msg_length).decode('utf-8')
    return json.loads(message)

def send_message(message_dict):
    encoded_message = json.dumps(message_dict).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('@I', len(encoded_message)))
    sys.stdout.buffer.write(encoded_message)
    sys.stdout.buffer.flush()

def extract_video_id(url: str) -> str:
    match = re.search(r'(?:v=|\/)([0-9A-Za-z_-]{11})', url)
    if match:
        return match.group(1)
    return None

def main():
    try:
        # Chrome拡張からのJSONメッセージを受信
        msg = get_message()
        url = msg.get('url')
        
        if not url:
            send_message({"success": False, "error": "URLが提供されていない。"})
            return

        video_id = extract_video_id(url)
        if not video_id:
            send_message({"success": False, "error": "有効なYouTube動画IDが抽出できなかった。"})
            return

        # 字幕の取得
        ytt_api = YouTubeTranscriptApi()
        transcript = ytt_api.fetch(video_id, languages=['ja', 'en'])
        
        formatter = TextFormatter()
        formatted_text = formatter.format_transcript(transcript)

        # Chrome拡張へ結果を返却
        send_message({"success": True, "transcript": formatted_text})

    except Exception as e:
        send_message({"success": False, "error": str(e)})

if __name__ == "__main__":
    main()