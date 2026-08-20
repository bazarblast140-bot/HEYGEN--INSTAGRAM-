import { Router } from 'express';
import { listAvatars, listVoices } from '../heygen.js';

const router = Router();

router.get('/avatars', async (req, res, next) => {
  try {
    res.json(await listAvatars());
  } catch (err) {
    next(err);
  }
});

router.get('/voices', async (req, res, next) => {
  try {
    const voices = await listVoices();
    const { language, q } = req.query;
    const needle = String(q || '').toLowerCase();

    res.json(
      voices.filter((v) => {
        if (language && String(v.language).toLowerCase() !== String(language).toLowerCase()) return false;
        if (needle && !String(v.name).toLowerCase().includes(needle)) return false;
        return true;
      }),
    );
  } catch (err) {
    next(err);
  }
});

export default router;
