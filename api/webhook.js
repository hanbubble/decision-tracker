const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

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
      try {
        await supabase.from('qa_items').insert({
          question: `슬랙 메시지 (채널: ${event.item?.channel || '알 수 없음'})`,
          status: 'open',
          source: 'slack',
          slack_channel: event.item?.channel,
          slack_ts: event.item?.ts,
          source_author: event.user,
        });
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
