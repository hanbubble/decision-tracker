const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const SLACK_HEADERS = () => ({
  Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
});

// 채널 메시지 가져오기 (스레드 답글 제외)
async function fetchChannelMessage(channel, ts) {
  const res = await fetch(
    `https://slack.com/api/conversations.history?channel=${channel}&latest=${ts}&inclusive=true&limit=1`,
    { headers: SLACK_HEADERS() }
  );
  const data = await res.json();
  if (!data.ok) console.error('Slack history error:', data.error);
  return data.messages?.[0] || null;
}

// 채널 메시지 + 스레드 답글 모두 커버
async function fetchAnyMessage(channel, ts) {
  const parent = await fetchChannelMessage(channel, ts);

  // ts가 정확히 일치 → 채널 메시지
  if (parent?.ts === ts) return parent;

  // ts 불일치 → 스레드 답글. parent가 루트 메시지
  if (parent) {
    const res = await fetch(
      `https://slack.com/api/conversations.replies?channel=${channel}&ts=${parent.ts}`,
      { headers: SLACK_HEADERS() }
    );
    const data = await res.json();
    if (!data.ok) console.error('Slack replies error:', data.error);
    return data.messages?.find(m => m.ts === ts) || null;
  }

  return null;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const source = req.query.source;
  const body = req.body;

  // ── Slack ──────────────────────────────────────────────────────────────
  if (source === 'slack') {
    if (body.type === 'url_verification') {
      return res.status(200).json({ challenge: body.challenge });
    }

    const event = body.event;
    if (event?.type !== 'reaction_added') {
      return res.status(200).json({ ok: true });
    }

    const channel = event.item?.channel;
    const ts = event.item?.ts;

    // ── ❓ 질문 등록 ────────────────────────────────────────────────────
    if (event.reaction === 'question') {
      let question = '(슬랙 메시지 내용을 가져오지 못했습니다)';
      try {
        const msg = await fetchAnyMessage(channel, ts);
        if (msg?.text) question = msg.text;
      } catch (e) {
        console.error('Slack fetch error:', e);
      }

      const { error } = await supabase.from('qa_items').insert({
        question,
        status: 'open',
        source: 'slack',
        slack_channel: channel,
        slack_ts: ts,
        source_author: event.user,
        source_url: `https://slack.com/archives/${channel}/p${ts?.replace('.', '')}`,
      });
      if (error) console.error('Insert error:', error);
      else console.log('Q&A question saved:', question.slice(0, 60));
    }

    // ── 🅰️ 답변 업데이트 ─────────────────────────────────────────────
    if (event.reaction === 'a') {
      let answerText = '';
      let parentTs = ts;

      try {
        const msg = await fetchAnyMessage(channel, ts);
        if (msg?.text) answerText = msg.text;
        // 스레드 답글이면 thread_ts = 부모 메시지 ts
        if (msg?.thread_ts && msg.thread_ts !== msg.ts) {
          parentTs = msg.thread_ts;
        }
        console.log('Answer msg ts:', msg?.ts, 'thread_ts:', msg?.thread_ts, 'parentTs:', parentTs);
      } catch (e) {
        console.error('Slack fetch error:', e);
      }

      if (answerText) {
        const { data: existing } = await supabase
          .from('qa_items')
          .select('id')
          .eq('slack_channel', channel)
          .eq('slack_ts', parentTs)
          .maybeSingle();

        if (!existing) {
          console.error('Q&A not found for ts:', parentTs);
        } else {
          const { error } = await supabase
            .from('qa_items')
            .update({ answer: answerText, status: 'resolved', resolved_at: new Date().toISOString() })
            .eq('id', existing.id);
          if (error) console.error('Update error:', error);
          else console.log('Q&A answer updated:', answerText.slice(0, 60));
        }
      }
    }

    return res.status(200).json({ ok: true });
  }

  // ── Figma ──────────────────────────────────────────────────────────────
  if (source === 'figma') {
    const { event_type, comment } = body;
    if (event_type === 'COMMENT') {
      const text = comment?.message || '';
      if (text.includes('@loopnote')) {
        try {
          await supabase.from('qa_items').insert({
            question: text.replace(/@loopnote/g, '').trim(),
            status: 'open',
            source: 'figma',
            figma_comment_id: comment?.id,
            figma_node_id: comment?.file_key,
            source_author: comment?.user?.handle,
          });
        } catch (e) {
          console.error('Supabase insert error:', e);
        }
      }
    }
    return res.status(200).json({ ok: true });
  }

  res.status(200).json({ ok: true });
};
