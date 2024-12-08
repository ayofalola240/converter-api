import mongoose from 'mongoose';
import app from './index.js';

// Error middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ success: false, error: 'Internal Server Error' });
});

const start = async () => {
  // if (!process.env.MONGO_URI) {
  //   throw new Error('MONGO_URI must be defined.');
  // }
  try {
    // await mongoose.connect(process.env.MONGO_URI);
    // console.log('Established connection to DB');

    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log('Server is running on Port ', PORT));
  } catch (err) {
    console.error(err);
  }
};

start();
