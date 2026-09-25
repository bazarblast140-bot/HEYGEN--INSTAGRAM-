// Referral links for daily finance carousels. Keep the disclosure with every link.
import { FINANCE } from './categories.js';

const DISCLOSURE = 'यह referral link है। इनमें से किसी link से account खोलने पर हमें referral benefit मिल सकता है। ये links किसी platform की सिफ़ारिश नहीं हैं।';
const LINKS = [
  ['Zerodha', 'https://zerodha.com/open-account?c=KU3466'],
  ['Upstox', 'https://upstox.onelink.me/0H1s/3T23'],
  ['INDmoney', 'https://indmoney.onelink.me/RmHC/615z6rm1'],
  ['Delta Exchange', 'https://www.delta.exchange/?code=TPBYQA'],
];

export function referralCaptionBlock({ category }) {
  if (!FINANCE.includes(category)) return '';
  return `\\n\\n${DISCLOSURE}\\n\\n${LINKS.map(([name, url]) => `${name}: ${url}`).join('\\n')}`;
}
