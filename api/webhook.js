const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function fetchSlackMessage(channel, ts) {
  const res = await fetch(
    `https://slack.com/api/conversations.history?channel=${channel}&latest=${ts}&inclusive=true&limit=1`,
    { headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` } }
  );
  const data = await res.json();
  if (!data.ok) console.error('Slack API error:', data.error);
  return data.messages?.[0]?.text || '';
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

    // reaction_added: ❓ 이모지 달린 메시지 수집
    if (body.event?.type === 'reaction_added' && body.event?.reaction === 'question') {
      const event = body.event;
      const channel = event.item?.channel;
      const ts = event.item?.ts;

      // 원본 메시지 내용 가져오기 (실패해도 계속 진행)
      let question = '(슬랙 메시지 내용을 가져오지 못했습니다)';
      try {
        const text = await fetchSlackMessage(channel, ts);
        if (text) question = text;
      } catch (e) {
        console.error('Slack API error:', e);
      }

      console.log('Inserting Q&A:', { question, channel, ts });
      try {
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
        else console.log('Q&A saved successfully');
      } catch (e) {
        console.error('Supabase insert error:', e);
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
