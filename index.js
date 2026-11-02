import 'dotenv/config';
import app from './app.js';
import dbConnect from './config/dbConnect.js';

const startServer = async () => {
  try {
    await dbConnect();

    const [host, port] = (
      process.env.AWS_LAMBDA_HTTP_ENDPOINT ||
      `127.0.0.1:${process.env.PORT || 3000}`
    ).split(':');

    app.listen(Number(port), host, () => {
      console.log(`Server running at http://${host}:${port}`);
    });
  } catch (error) {
    console.error('Server startup failed:', error.message);
    process.exitCode = 1;
  }
};

startServer();