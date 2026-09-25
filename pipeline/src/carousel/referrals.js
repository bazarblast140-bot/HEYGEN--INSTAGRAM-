// One-time referral links for the 2026-09-25 evening finance carousel.
const CAMPAIGN = Object.freeze({
  date: '2026-09-25',
  slot: 'evening',
  category: 'markets',
  disclosure: 'यह referral link है। इनमें से किसी link से account खोलने पर हमें referral benefit मिल सकता है। ये links किसी platform की सिफ़ारिश नहीं हैं।',
  links: [
    ['Zerodha', 'https://zerodha.com/open-account?c=KU3466'],
    ['Upstox', 'https://upstox.onelink.me/0H1s/3T23'],
    ['INDmoney', 'https://indmoney.onelink.me/RmHC/615z6rm1'],
    ['Delta Exchange', 'https://www.delta.exchange/?code=TPBYQA'],
  ],
});

export function referralCaptionBlock({ date, slot, category }) {
  if (date !== CAMPAIGN.date || slot !== CAMPAIGN.slot || category !== CAMPAIGN.category) return '';
  return `\n\n${CAMPAIGN.disclosure}\n\n${CAMPAIGN.links.map(([name, url]) => `${name}: ${url}`).join('\n')}`;
}
