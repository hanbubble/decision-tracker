module.exports = async function handler(req, res) {
  const { code, error } = req.query;

  if (error) {
    return res.status(200).send('<h2>설치 취소됨</h2>');
  }

  if (!code) {
    return res.status(400).send('<h2>잘못된 요청</h2>');
  }

  const params = new URLSearchParams({
    client_id: process.env.SLACK_CLIENT_ID,
    client_secret: process.env.SLACK_CLIENT_SECRET,
    code,
  });

  const response = await fetch(`https://slack.com/api/oauth.v2.access?${params}`);
  const data = await response.json();

  if (!data.ok) {
    console.error('Slack OAuth error:', data.error);
    return res.status(200).send(`<h2>설치 실패: ${data.error}</h2>`);
  }

  console.log('Slack app installed to workspace:', data.team?.name);
  console.log('BOT_TOKEN:', data.access_token);
  return res.status(200).send('<h2>✅ 슬랙 앱 설치 완료!</h2><p>이 창을 닫아도 됩니다.</p>');
};
