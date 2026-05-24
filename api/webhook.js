const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// 슬랙 메시지 전체 객체 반환 (text + thread_ts 포함)
async function fetchSlackMessage(channel, ts) {
  const res = await fetch(
    `https://slack.com/api/conversations.history?channel=${channel}&latest=${ts}&inclusive=true&limit=1`,
    { headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` } }
  );
  const data = await res.json();
  if (!data.ok) console.error('Slack API error:', data.error);
  return data.messages?.[0] || null;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const source = req.query.source;
  const body = req.body;

  // ── Slack ──────────────────────────────────────────────────────────────
  if (source === 'slack') {
    // URL 검증 challenge
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
        const msg = await fetchSlackMessage(channel, ts);
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
      if (error) console.error('Supabase insert error:', error);
      else console.log('Q&A question saved:', question.slice(0, 60));
    }

    // ── 🅰️ 답변 업데이트 ─────────────────────────────────────────────
    if (event.reaction === 'a') {
      let answerText = '';
      let parentTs = ts;

      try {
        const msg = await fetchSlackMessage(channel, ts);
        if (msg?.text) answerText = msg.text;
        // 스레드 답글이면 thread_ts가 부모 메시지 ts
        if (msg?.thread_ts && msg.thread_ts !== ts) parentTs = msg.thread_ts;
      } catch (e) {
        console.error('Slack fetch error:', e);
      }

      if (answerText) {
        // 부모 메시지 ts로 Q&A 찾기
        const { data: existing, error: findErr } = await supabase
          .from('qa_items')
          .select('id')
          .eq('slack_channel', channel)
          .eq('slack_ts', parentTs)
          .single();

        if (findErr) {
          console.error('Q&A not found for ts:', parentTs, findErr.message);
        } else {
          const { error } = await supabase
            .from('qa_items')
            .update({ answer: answerText, status: 'resolved', resolved_at: new Date().toISOString() })
            .eq('id', existing.id);
          if (error) console.error('Supabase update error:', error);
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
