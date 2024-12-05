// server.js

// ============================ Module Imports ============================ //
import express from 'express';
import path from 'path';
import cors from 'cors';
import morgan from 'morgan';
import compression from 'compression';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import mongoose from 'mongoose';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';
import nodemailer from 'nodemailer';
import { fileURLToPath } from 'url';
import passport from 'passport';
import session from 'express-session';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import asyncHandler from 'express-async-handler';
import winston from 'winston'; // For logging
import { Server } from 'socket.io';
import http from 'http';
import MongoStore from 'connect-mongo';
import multer from 'multer';
import fs from 'fs';
import { body, validationResult } from 'express-validator'; // For input validation

// ======================== Environment Configuration ======================= //

dotenv.config();

// Validate Required Environment Variables
const requiredEnvVars = [
  'BASE_URL',
  'MONGODB_URI',
  'JWT_SECRET',
  'EMAIL_USER',
  'EMAIL_APP_PASSWORD',
  'SESSION_SECRET',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'CORS_ORIGIN',
  'PORT',
];
requiredEnvVars.forEach((varName) => {
  if (!process.env[varName]) {
    console.error(`❌ Missing required environment variable: ${varName}`);
    process.exit(1);
  }
});

// Destructure Environment Variables with Defaults
const {
  BASE_URL = 'http://localhost:3000',
  PORT = process.env.PORT || 3000,
  NODE_ENV = 'development',
  JWT_EXPIRES_IN = '1h',
  CORS_ORIGIN,
  BCRYPT_SALT_ROUNDS = '10',
} = process.env;

// =========================== Initialize App ============================ //

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: CORS_ORIGIN,
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// Determine __dirname in ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =========================== Logger Setup ============================ //

// Configure winston logger
const logger = winston.createLogger({
  level: NODE_ENV === 'production' ? 'info' : 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(
      ({ timestamp, level, message, ...meta }) =>
        `${timestamp} [${level.toUpperCase()}]: ${message} ${
          Object.keys(meta).length ? JSON.stringify(meta) : ''
        }`
    )
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/server.log' }),
  ],
});

// ======================== Database Connection ========================== //

mongoose
  .connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    // useCreateIndex: true, // Not needed in Mongoose 6+
  })
  .then(() => logger.info('✅ MongoDB connected successfully'))
  .catch((error) => {
    logger.error('❌ MongoDB connection error:', error);
    process.exit(1);
  });

// ====================== Define Schemas and Models ====================== //

// User Schema
const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true }, // Full name
    email: { type: String, required: true, unique: true },
    password: { type: String },
    googleId: { type: String },
    sessionID: { type: String },
    isVerified: { type: Boolean, default: false },
    lastLogin: { type: Date },
    role: { type: String, enum: ['user', 'admin'], default: 'user' },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    theme: { type: String, default: 'light' }, // User preference
    profileSetup: { type: Boolean, default: false }, // Profile setup flag
    bio: { type: String }, // Additional profile fields
    avatar: { type: String }, // URL to the uploaded avatar
    phoneNumber: { type: String }, // User's phone number
    ip: { type: String }, // User's IP address
    userAgent: { type: String }, // User's browser user agent
    profileSetupToken: { type: String }, // Token for profile setup
    profileSetupTokenExpires: { type: Date }, // Token expiration
  },
  { timestamps: true }
);

// Ticket Schema
const ticketSchema = new mongoose.Schema(
  {
    subject: { type: String, required: true },
    content: { type: String, required: true },
    status: { type: String, enum: ['open', 'closed'], default: 'open' },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// Guide Schema
const guideSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    slug: { type: String, required: true },
    subtitle: String,
    summary: String,
    content: { type: String, required: true },
    tags: [String],
    category: { type: String, required: true },
    bannerImage: String,
    author: {
      id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      name: String,
      email: String,
    },
    publishDate: String,
    views: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// Ensure unique combination of slug and category
guideSchema.index({ slug: 1, category: 1 }, { unique: true });

const User = mongoose.model('User', userSchema);
const Guide = mongoose.model('Guide', guideSchema);
const Ticket = mongoose.model('Ticket', ticketSchema);

// Chat Message Schema
const chatMessageSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    message: { type: String, required: true },
    sender: { type: String, enum: ['user', 'admin', 'bot'], required: true },
    timestamp: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

const ChatMessage = mongoose.model('ChatMessage', chatMessageSchema);

// ========================= Utility Functions =========================== //

/**
 * Generate JWT Token
 * @param {Object} user - User object
 * @param {String} expiresIn - Token expiration time
 * @returns {String} JWT Token
 */
const generateToken = (user, expiresIn = JWT_EXPIRES_IN) => {
  return jwt.sign(
    {
      id: user._id,
      email: user.email,
      role: user.role,
      isVerified: user.isVerified,
      name: user.name,
    },
    process.env.JWT_SECRET,
    { expiresIn }
  );
};

/**
 * Generate a random Session ID
 * @returns {String} Session ID
 */
const generateSessionID = () => crypto.randomBytes(16).toString('hex');

/**
 * Send Verification Email
 * @param {Object} user - User object
 * @param {String} token - JWT Token
 */
const sendVerificationEmail = async (user, token) => {
  const verifyLink = `${BASE_URL}/verify-email?token=${token}`;

  const mailOptions = {
    from: `"No Reply" <${process.env.EMAIL_USER}>`,
    to: user.email,
    subject: '🔒 Verify Your Email',
    html: `
      <div style="font-family: Arial, sans-serif;">
        <h2>Welcome, ${user.name}!</h2>
        <p>Thank you for registering. Please verify your email address to activate your account:</p>
        <a href="${verifyLink}" style="background-color: #4CAF50; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Verify Email</a>
        <p>If you did not sign up for this account, you can ignore this email.</p>
      </div>
    `,
  };

  await transporter.sendMail(mailOptions);
};

/**
 * Send Welcome Email
 * @param {Object} user - User object
 */
const sendWelcomeEmail = async (user) => {
  const mailOptions = {
    from: `"No Reply" <${process.env.EMAIL_USER}>`,
    to: user.email,
    subject: '🎉 Welcome to Support Pro!',
    html: `
      <div style="font-family: Arial, sans-serif;">
        <h2>Welcome, ${user.name}!</h2>
        <p>We're excited to have you on board. Explore our features and let us know if you have any questions.</p>
        <p>Best Regards,<br/>The Support Pro Team</p>
      </div>
    `,
  };

  await transporter.sendMail(mailOptions);
};

/**
 * Generate a URL-friendly slug from a string
 * @param {String} text - The input text
 * @returns {String} - The generated slug
 */
const generateSlug = (text) => {
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '') // Remove non-word characters
    .replace(/[\s_-]+/g, '-') // Replace spaces and underscores with '-'
    .replace(/^-+|-+$/g, ''); // Remove leading and trailing hyphens
};

/**
 * Generate a unique token for profile setup
 * @returns {String} - Unique token
 */
const generateProfileSetupToken = () => {
  return crypto.randomBytes(32).toString('hex');
};

// ======================== Nodemailer Configuration ====================== //

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_APP_PASSWORD,
  },
});

// ====================== Passport Configuration ========================== //

// Passport Configuration for Google OAuth
passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: `${BASE_URL}/auth/google/callback`,
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        // Extract email
        const email = profile.emails[0].value;

        // Check if user with this email already exists
        let user = await User.findOne({ email });

        if (user) {
          // If user exists but doesn't have Google ID, link it
          if (!user.googleId) {
            user.googleId = profile.id;
            await user.save();
          }
          return done(null, user);
        }

        // If user doesn't exist, create new
        user = await User.create({
          googleId: profile.id,
          name: profile.displayName,
          email: email,
          isVerified: true, // Google OAuth provides verified email
          role: 'user',
          profileSetup: false,
        });

        // Send Welcome Email
        await sendWelcomeEmail(user);

        return done(null, user);
      } catch (err) {
        return done(err, null);
      }
    }
  )
);

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id);
    done(null, user);
  } catch (err) {
    done(err, null);
  }
});

// ========================== Rate Limiting ============================ //

// *** RATE LIMITING HAS BEEN REMOVED AS PER USER REQUEST ***
// Previously, rate limiting configurations like generalLimiter and authLimiter were set up here.
// These have been omitted to remove rate limits.

// ========================== Middleware Setup =========================== //

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  cors({
    origin: CORS_ORIGIN,
    credentials: true,
  })
);
app.use(morgan(NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(compression());
app.use(cookieParser());

// ================== Session Configuration ==================

app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
      mongoUrl: process.env.MONGODB_URI,
      collectionName: 'sessions',
    }),
    cookie: {
      secure: NODE_ENV === 'production', // Ensure HTTPS in production
      httpOnly: true,
      sameSite: 'strict',
      maxAge: 24 * 60 * 60 * 1000, // 1 day
    },
  })
);

app.use(passport.initialize());
app.use(passport.session());

// ================== Authentication Middleware ================== //

/**
 * Middleware to check if the request is for an API route
 * @param {Object} req - Express request object
 * @returns {Boolean} - True if API route, else false
 */
const isApiRoute = (req) => req.path.startsWith('/api/');

/**
 * Authenticate JWT Token
 * For API routes: returns JSON errors
 * For Web routes: redirects to login pages
 */
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = req.cookies.token || (authHeader && authHeader.split(' ')[1]);
  if (!token) {
    logger.warn('Unauthorized access attempt.', { url: req.originalUrl });
    if (isApiRoute(req)) {
      return res.status(401).json({ error: 'Unauthorized access. Please log in.' });
    } else {
      // Determine redirect based on route
      if (req.path.startsWith('/admin/')) {
        return res.redirect('/admin/login');
      } else {
        return res.redirect('/auth/login');
      }
    }
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, decodedUser) => {
    if (err) {
      logger.warn('Invalid token provided.', { token });
      if (isApiRoute(req)) {
        return res.status(403).json({ error: 'Forbidden. Invalid token.' });
      } else {
        // Determine redirect based on route
        if (req.path.startsWith('/admin/')) {
          return res.redirect('/admin/login');
        } else {
          return res.redirect('/auth/login');
        }
      }
    }
    req.user = decodedUser;
    next();
  });
};

/**
 * Authenticate Admin Users
 * Extends authenticateToken to check for admin role
 */
const authenticateAdmin = (req, res, next) => {
  authenticateToken(req, res, () => {
    if (req.user.role !== 'admin') {
      logger.warn('Admin access denied. Insufficient permissions.', { userRole: req.user.role });
      if (isApiRoute(req)) {
        return res.status(403).json({ error: 'Access Denied: Admins only.' });
      } else {
        return res.redirect('/admin/login');
      }
    }
    next();
  });
};

/**
 * Middleware to check if user's profile is set up
 */
const checkProfileSetup = asyncHandler(async (req, res, next) => {
  const user = await User.findById(req.user.id);
  if (!user.profileSetup) {
    if (isApiRoute(req)) {
      return res.status(200).json({
        message: '✅ Login successful. Please set up your profile.',
        redirect: '/auth/setup-profile.html',
      });
    } else {
      return res.redirect('/auth/setup-profile.html');
    }
  }
  next();
});

/**
 * Middleware to check if user is authenticated and profile is set up
 * Used for frontend redirection
 */
const ensureAuthenticatedAndSetup = asyncHandler(async (req, res, next) => {
  const token = req.cookies.token;
  if (!token) {
    return res.redirect('/auth/login');
  }

  jwt.verify(token, process.env.JWT_SECRET, async (err, decodedUser) => {
    if (err) {
      return res.redirect('/auth/login');
    }
    req.user = decodedUser;
    const user = await User.findById(req.user.id);
    if (!user.profileSetup) {
      return res.redirect('/auth/setup-profile.html');
    }
    next();
  });
});

// =========================== Multer Configuration ====================== //

// Create 'uploads' directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure Multer Storage
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    // Generate unique filename
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    // Extract file extension
    const ext = path.extname(file.originalname);
    cb(null, file.fieldname + '-' + uniqueSuffix + ext);
  },
});

// File Filter to accept only images
const fileFilter = (req, file, cb) => {
  const allowedTypes = /jpeg|jpg|png|gif/;
  const ext = allowedTypes.test(path.extname(file.originalname).toLowerCase());
  const mime = allowedTypes.test(file.mimetype);
  if (ext && mime) {
    return cb(null, true);
  } else {
    cb(new Error('Only JPEG, PNG, and GIF images are allowed.'));
  }
};

const upload = multer({
  storage: storage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter: fileFilter,
});

// =============================== Routes ================================ //

/**
 * Serve static files
 */
app.use(express.static(path.join(__dirname, 'public')));

/**
 * Define Static Routes with Optional Authentication Redirection
 */
const definedRoutes = [
  {
    route: '/auth',
    file: path.join(__dirname, 'public', 'auth', 'auth.html'),
    redirectIfAuthenticated: true,
  },
  {
    route: '/auth/login',
    file: path.join(__dirname, 'public', 'auth', 'login.html'),
    redirectIfAuthenticated: true,
  },
  {
    route: '/auth/signup',
    file: path.join(__dirname, 'public', 'auth', 'signup.html'),
    redirectIfAuthenticated: true,
  },
  {
    route: '/auth/setup-profile.html',
    file: path.join(__dirname, 'public', 'auth', 'setup-profile.html'),
    requiresAuth: true,
    requiresProfileSetup: false, // Only users who haven't set up profile
  },
  {
    route: '/dashboard',
    file: path.join(__dirname, 'public', 'dashboard', 'dashboard.html'),
    requiresAuth: true,
    extraMiddlewares: [checkProfileSetup],
  },
  // Removed specific OS routes from definedRoutes to handle them dynamically
  {
    route: '/dashboard/profile.html',
    file: path.join(__dirname, 'public', 'dashboard', 'profile.html'),
    requiresAuth: true,
  },
  {
    route: '/admin',
    file: path.join(__dirname, 'public', 'admin', '/admin'),
    requiresAuth: true,
    requiresAdmin: true,
  },
  // Removed specific admin section routes from definedRoutes to handle them dynamically
  {
    route: '/admin/login',
    file: path.join(__dirname, 'public', 'admin', 'login.html'),
    redirectIfAuthenticated: true,
  },
  // Add more routes as needed
];

/**
 * Function to set up routes
 */
const setupRoutes = () => {
  definedRoutes.forEach(
    ({
      route,
      file,
      redirectIfAuthenticated,
      requiresAuth,
      requiresAdmin,
      requiresProfileSetup,
      extraMiddlewares,
    }) => {
      if (redirectIfAuthenticated) {
        app.get(
          route,
          asyncHandler(async (req, res, next) => {
            const token = req.cookies.token;
            if (token) {
              try {
                const decoded = jwt.verify(token, process.env.JWT_SECRET);
                return res.redirect(
                  route.includes('login') || route.includes('signup') ? '/dashboard' : '/'
                );
              } catch (err) {
                // Invalid token, proceed to serve the page
              }
            }
            next();
          }),
          (req, res) => {
            res.sendFile(file);
          }
        );
      } else if (requiresAuth) {
        // Build middleware array dynamically to avoid passing null
        const middlewares = [authenticateToken];
        if (requiresAdmin) {
          middlewares.push(authenticateAdmin);
        }
        if (extraMiddlewares && Array.isArray(extraMiddlewares)) {
          middlewares.push(...extraMiddlewares);
        }
        if (requiresProfileSetup === false) {
          // For setup-profile.html, ensure profile is not set up
          middlewares.push(asyncHandler(async (req, res, next) => {
            const user = await User.findById(req.user.id);
            if (user.profileSetup) {
              return res.redirect('/dashboard');
            }
            next();
          }));
        }
        app.get(route, ...middlewares, (req, res) => {
          res.sendFile(file);
        });
      } else {
        app.get(route, (req, res) => {
          res.sendFile(file);
        });
      }
    }
  );
};

// Initialize routes
setupRoutes();

/**
 * Dynamic Dashboard OS Routes
 */
const allowedOS = ['windows', 'macos', 'linux', 'ios', 'android', 'chromeos'];

app.get(
  '/dashboard/:os',
  authenticateToken,
  checkProfileSetup,
  asyncHandler(async (req, res) => {
    const osParam = req.params.os.toLowerCase();

    if (!allowedOS.includes(osParam)) {
      logger.warn('Dashboard OS route accessed with invalid OS.', { os: osParam });
      if (isApiRoute(req)) {
        return res.status(404).json({ error: 'Not found' });
      } else {
        return res.status(404).sendFile(path.join(__dirname, 'public', 'error', '404.html'));
      }
    }

    const osFile = path.join(__dirname, 'public', 'dashboard', `${osParam}.html`);
    if (fs.existsSync(osFile)) {
      res.sendFile(osFile);
    } else {
      logger.warn('Dashboard OS file not found.', { os: osParam, osFile });
      if (isApiRoute(req)) {
        return res.status(404).json({ error: 'Not found' });
      } else {
        res.status(404).sendFile(path.join(__dirname, 'public', 'error', '404.html'));
      }
    }
  })
);

/**
 * Dynamic Admin Panel Section Routes
 */
const allowedAdminSections = ['tickets', 'guides', 'logs', 'users'];

app.get(
  '/admin/:section',
  authenticateAdmin,
  asyncHandler(async (req, res) => {
    const sectionParam = req.params.section.toLowerCase();

    if (!allowedAdminSections.includes(sectionParam)) {
      logger.warn('Admin section route accessed with invalid section.', { section: sectionParam });
      if (isApiRoute(req)) {
        return res.status(404).json({ error: 'Not found' });
      } else {
        return res.status(404).sendFile(path.join(__dirname, 'public', 'error', '404.html'));
      }
    }

    const sectionFile = path.join(__dirname, 'public', 'admin', `${sectionParam}.html`);
    if (fs.existsSync(sectionFile)) {
      res.sendFile(sectionFile);
    } else {
      logger.warn('Admin section file not found.', { section: sectionParam, sectionFile });
      if (isApiRoute(req)) {
        return res.status(404).json({ error: 'Not found' });
      } else {
        res.status(404).sendFile(path.join(__dirname, 'public', 'error', '404.html'));
      }
    }
  })
);

/**
 * OAuth Routes
 */
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

app.get(
  '/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/auth/login' }),
  asyncHandler(async (req, res) => {
    // Successful authentication, generate JWT token and set cookie
    const token = generateToken(req.user);
    res.cookie('token', token, {
      httpOnly: true,
      secure: NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 24 * 60 * 60 * 1000, // 1 day
    });

    // Check if profile is set up
    if (!req.user.profileSetup) {
      return res.redirect('/auth/setup-profile.html');
    }

    res.redirect('/dashboard');
  })
);

/**
 * API Endpoints
 */

// User Registration Endpoint
app.post(
  '/api/signup',
  // *** RATE LIMITING HAS BEEN REMOVED ***
  // Previously, authLimiter was applied here
  // Removed to disable rate limiting
  // authLimiter,
  // Input Validation and Sanitization
  [
    body('name').trim().notEmpty().withMessage('Name is required.'),
    body('email').isEmail().withMessage('Valid email is required.').normalizeEmail(),
    body('password')
      .isLength({ min: 6 })
      .withMessage('Password must be at least 6 characters long.')
      .escape(),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      logger.warn('Signup failed: Validation errors.', { errors: errors.array() });
      return res.status(400).json({ errors: errors.array() });
    }

    const { name, email, password } = req.body;

    try {
      const existingUser = await User.findOne({ email });

      if (existingUser && existingUser.password) {
        logger.warn('Signup failed: User already exists.', { email });
        return res.status(400).json({ error: '❌ User already exists with this email.' });
      }

      const hashedPassword = await bcrypt.hash(password, parseInt(BCRYPT_SALT_ROUNDS));
      const sessionID = generateSessionID();
      const profileSetupToken = generateProfileSetupToken();
      const profileSetupTokenExpires = Date.now() + 24 * 60 * 60 * 1000; // 24 hours

      let user;
      if (existingUser) {
        existingUser.password = hashedPassword;
        existingUser.sessionID = sessionID;
        existingUser.name = name; // Update name if provided
        existingUser.profileSetupToken = profileSetupToken;
        existingUser.profileSetupTokenExpires = profileSetupTokenExpires;
        user = await existingUser.save();
      } else {
        user = new User({
          name,
          email,
          password: hashedPassword,
          sessionID,
          role: 'user',
          profileSetupToken,
          profileSetupTokenExpires,
        });
        await user.save();
      }

      // Send profile setup email with unique URL
      const setupProfileLink = `${BASE_URL}/auth/setup-profile?token=${profileSetupToken}`;
      const mailOptions = {
        from: `"No Reply" <${process.env.EMAIL_USER}>`,
        to: user.email,
        subject: '🔑 Complete Your Profile Setup',
        html: `
          <div style="font-family: Arial, sans-serif;">
            <h2>Hello, ${user.name}!</h2>
            <p>Thank you for registering. Please complete your profile setup by clicking the link below:</p>
            <a href="${setupProfileLink}" style="background-color: #4CAF50; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Complete Profile Setup</a>
            <p>This link is valid for 24 hours and can only be used once.</p>
            <p>If you did not sign up for this account, you can ignore this email.</p>
          </div>
        `,
      };

      await transporter.sendMail(mailOptions);

      logger.info(`User registered: ${email}`, { userId: user._id });
      res.status(201).json({
        message: '✅ User registered successfully. Please check your email to complete profile setup.',
      });
    } catch (err) {
      if (err.code === 11000) {
        logger.error('Signup error: Duplicate email.', { email });
        res.status(400).json({ error: '❌ Email already in use.' });
      } else {
        logger.error('Signup error:', err);
        res.status(500).json({ error: '❌ Server error. Please try again later.' });
      }
    }
  })
);

// Login Endpoint
app.post(
  '/api/login',
  // *** RATE LIMITING HAS BEEN REMOVED ***
  // Previously, authLimiter was applied here
  // Removed to disable rate limiting
  // authLimiter,
  // Input Validation and Sanitization
  [
    body('email').isEmail().withMessage('Valid email is required.').normalizeEmail(),
    body('password').notEmpty().withMessage('Password is required.').escape(),
    body('rememberMe').optional().isBoolean(),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      logger.warn('Login failed: Validation errors.', { errors: errors.array() });
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password, rememberMe } = req.body;

    try {
      const user = await User.findOne({ email });

      if (!user || !user.password) {
        logger.warn('Login failed: User does not exist.', { email });
        return res.status(404).json({ error: '❌ User does not exist. Please sign up.' });
      }

      const isMatch = await bcrypt.compare(password, user.password);

      if (!isMatch) {
        logger.warn('Login failed: Invalid credentials.', { email });
        return res.status(401).json({ error: '❌ Invalid credentials.' });
      }

      if (!user.isVerified) {
        logger.warn('Login failed: Email not verified.', { email });
        return res.status(403).json({
          error: '❌ Please verify your email before logging in.',
        });
      }

      // Set token expiration based on rememberMe
      const tokenExpiry = rememberMe ? '7d' : JWT_EXPIRES_IN;

      const token = generateToken(user, tokenExpiry);
      const sessionID = generateSessionID();
      user.sessionID = sessionID;
      user.lastLogin = new Date();
      user.ip = req.ip;
      user.userAgent = req.get('User-Agent');
      await user.save();

      res.cookie('token', token, {
        httpOnly: true,
        secure: NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: rememberMe ? 7 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000, // 7 days or 1 day
      });

      logger.info(`User logged in: ${email}`, { userId: user._id });

      // Check if profile is set up
      if (!user.profileSetup) {
        return res.status(200).json({
          message: '✅ Login successful. Please complete your profile setup.',
          redirect: '/auth/setup-profile.html',
        });
      }

      res.status(200).json({
        message: '✅ Login successful.',
        redirect: '/dashboard',
        userInfo: {
          name: user.name,
          email: user.email,
          lastLogin: user.lastLogin,
          isVerified: user.isVerified,
          role: user.role,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt,
        },
      });
    } catch (err) {
      logger.error('Login error:', err);
      res.status(500).json({ error: '❌ Server error. Please try again later.' });
    }
  })
);

// Logout Endpoint
app.post(
  '/api/logout',
  authenticateToken,
  asyncHandler(async (req, res) => {
    try {
      const user = await User.findById(req.user.id);
      if (user) {
        user.sessionID = null;
        await user.save();
      }

      res.clearCookie('token', {
        path: '/',
        httpOnly: true,
        secure: NODE_ENV === 'production',
        sameSite: 'strict',
      });
      logger.info(`User logged out: ${req.user.email}`, { userId: req.user.id });
      res.status(200).json({ message: '✅ Logout successful.' });
    } catch (error) {
      logger.error('Logout error:', error);
      res.status(500).json({ error: '❌ Server error during logout.' });
    }
  })
);

/**
 * Verify Email Endpoint
 */
app.get(
  '/verify-email',
  asyncHandler(async (req, res) => {
    const token = req.query.token;

    if (!token) {
      return res.status(400).json({ error: '❌ Invalid verification link.' });
    }

    jwt.verify(token, process.env.JWT_SECRET, async (err, decodedUser) => {
      if (err) {
        logger.warn('Email verification failed: Invalid token.', { token });
        return res.status(400).json({ error: '❌ Invalid verification link.' });
      }

      try {
        const user = await User.findById(decodedUser.id);

        if (!user) {
          return res.status(404).json({ error: '❌ User not found.' });
        }

        if (user.isVerified) {
          return res.status(400).json({ error: '❌ Email is already verified.' });
        }

        user.isVerified = true;
        await user.save();

        logger.info(`User verified: ${user.email}`, { userId: user._id });
        res.redirect('/auth/login');
      } catch (error) {
        logger.error('Email verification error:', error);
        res.status(500).json({ error: '❌ Server error. Please try again later.' });
      }
    });
  })
);

/**
 * Resend Verification Email Endpoint
 */
app.post(
  '/api/resend-verification',
  authenticateToken,
  asyncHandler(async (req, res) => {
    try {
      const user = await User.findById(req.user.id);

      if (!user) {
        return res.status(404).json({ error: '❌ User not found.' });
      }

      if (user.isVerified) {
        return res.status(400).json({ error: '❌ Email is already verified.' });
      }

      // Generate new profile setup token
      const profileSetupToken = generateProfileSetupToken();
      const profileSetupTokenExpires = Date.now() + 24 * 60 * 60 * 1000; // 24 hours

      user.profileSetupToken = profileSetupToken;
      user.profileSetupTokenExpires = profileSetupTokenExpires;
      await user.save();

      // Send profile setup email with unique URL
      const setupProfileLink = `${BASE_URL}/auth/setup-profile?token=${profileSetupToken}`;
      const mailOptions = {
        from: `"No Reply" <${process.env.EMAIL_USER}>`,
        to: user.email,
        subject: '🔑 Complete Your Profile Setup',
        html: `
          <div style="font-family: Arial, sans-serif;">
            <h2>Hello, ${user.name}!</h2>
            <p>Please complete your profile setup by clicking the link below:</p>
            <a href="${setupProfileLink}" style="background-color: #4CAF50; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Complete Profile Setup</a>
            <p>This link is valid for 24 hours and can only be used once.</p>
            <p>If you did not request this, please ignore this email.</p>
          </div>
        `,
      };

      await transporter.sendMail(mailOptions);

      logger.info(`Verification email resent to: ${user.email}`, { userId: user._id });
      res.status(200).json({ message: '✅ Verification email resent successfully.' });
    } catch (error) {
      logger.error('Error resending verification email:', error);
      res.status(500).json({ error: '❌ Server error. Please try again later.' });
    }
  })
);

// ========================= Password Reset Endpoints ========================= //

/**
 * Request Password Reset
 */
app.post(
  '/api/password-reset/request',
  // *** RATE LIMITING HAS BEEN REMOVED ***
  // Previously, authLimiter was applied here
  // Removed to disable rate limiting
  // authLimiter,
  [
    body('email').isEmail().withMessage('Valid email is required.').normalizeEmail(),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      logger.warn('Password reset request failed: Validation errors.', { errors: errors.array() });
      return res.status(400).json({ errors: errors.array() });
    }

    const { email } = req.body;

    try {
      const user = await User.findOne({ email });
      if (!user) {
        return res.status(404).json({ error: '❌ User not found.' });
      }

      const resetToken = jwt.sign(
        { id: user._id },
        process.env.JWT_SECRET,
        { expiresIn: '1h' }
      );

      const resetLink = `${BASE_URL}/auth/password-reset.html?token=${resetToken}`;

      const mailOptions = {
        from: `"No Reply" <${process.env.EMAIL_USER}>`,
        to: user.email,
        subject: '🔑 Password Reset Request',
        html: `
          <div style="font-family: Arial, sans-serif;">
            <h2>Hello, ${user.name}!</h2>
            <p>You requested to reset your password. Click the link below to proceed:</p>
            <a href="${resetLink}" style="background-color: #4CAF50; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Reset Password</a>
            <p>This link will expire in 1 hour. If you did not request a password reset, please ignore this email.</p>
          </div>
        `,
      };

      await transporter.sendMail(mailOptions);

      logger.info(`Password reset email sent to: ${email}`, { userId: user._id });
      res.status(200).json({ message: '✅ Password reset email sent.' });
    } catch (error) {
      logger.error('Error sending password reset email:', error);
      res.status(500).json({ error: '❌ Server error. Please try again later.' });
    }
  })
);

/**
 * Confirm Password Reset
 */
app.post(
  '/api/password-reset/confirm',
  // *** RATE LIMITING HAS BEEN REMOVED ***
  // Previously, authLimiter was applied here
  // Removed to disable rate limiting
  // authLimiter,
  [
    body('token').notEmpty().withMessage('Token is required.').trim(),
    body('newPassword')
      .isLength({ min: 6 })
      .withMessage('Password must be at least 6 characters long.')
      .escape(),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      logger.warn('Password reset confirm failed: Validation errors.', { errors: errors.array() });
      return res.status(400).json({ errors: errors.array() });
    }

    const { token, newPassword } = req.body;

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.id);

      if (!user) {
        return res.status(404).json({ error: '❌ User not found.' });
      }

      user.password = await bcrypt.hash(newPassword, parseInt(BCRYPT_SALT_ROUNDS));
      await user.save();

      logger.info(`Password reset successfully for user: ${user.email}`, { userId: user._id });
      res.status(200).json({ message: '✅ Password reset successfully.' });
    } catch (error) {
      logger.error('Error resetting password:', error);
      res.status(400).json({ error: '❌ Invalid or expired token.' });
    }
  })
);

// ========================= Profile Setup Endpoint ========================= //

/**
 * Profile Setup Endpoint with Image Upload and One-Time Token Validation
 */
app.get(
  '/auth/setup-profile',
  asyncHandler(async (req, res) => {
    const token = req.query.token;

    if (!token) {
      return res.status(400).sendFile(path.join(__dirname, 'public', 'error', '400.html'));
    }

    jwt.verify(token, process.env.JWT_SECRET, async (err, decoded) => {
      if (err) {
        logger.warn('Profile setup failed: Invalid token.', { token });
        return res.status(400).sendFile(path.join(__dirname, 'public', 'error', '400.html'));
      }

      try {
        const user = await User.findById(decoded.id);

        if (!user) {
          return res.status(404).sendFile(path.join(__dirname, 'public', 'error', '404.html'));
        }

        if (user.profileSetup) {
          return res.redirect('/dashboard');
        }

        if (
          user.profileSetupToken !== token ||
          user.profileSetupTokenExpires < Date.now()
        ) {
          return res.status(400).sendFile(path.join(__dirname, 'public', 'error', '400.html'));
        }

        // Token is valid, render setup-profile.html
        res.sendFile(path.join(__dirname, 'public', 'auth', 'setup-profile.html'));
      } catch (error) {
        logger.error('Profile setup validation error:', error);
        res.status(500).sendFile(path.join(__dirname, 'public', 'error', '500.html'));
      }
    });
  })
);

/**
 * Handle Profile Setup Submission
 */
app.post(
  '/api/profile/setup',
  upload.single('profilePicture'), // Handle 'profilePicture' field
  [
    body('fullName').trim().notEmpty().withMessage('Full Name is required.').escape(),
    body('phoneNumber')
      .trim()
      .notEmpty()
      .withMessage('Phone Number is required.')
      .matches(/^[0-9+\-()\s]+$/)
      .withMessage('Invalid phone number format.')
      .escape(),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    const profilePicture = req.file;
    const token = req.body.token; // Assume token is sent as part of the form data

    if (!errors.isEmpty()) {
      // If using multer, file is handled separately
      if (profilePicture) {
        fs.unlinkSync(profilePicture.path);
      }
      logger.warn('Profile setup failed: Validation errors.', { errors: errors.array() });
      return res.status(400).json({ errors: errors.array() });
    }

    if (!token) {
      if (profilePicture) {
        fs.unlinkSync(profilePicture.path);
      }
      return res.status(400).json({ error: '❌ Missing profile setup token.' });
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.id);

      if (!user) {
        if (profilePicture) {
          fs.unlinkSync(profilePicture.path);
        }
        return res.status(404).json({ error: '❌ User not found.' });
      }

      if (user.profileSetup) {
        if (profilePicture) {
          fs.unlinkSync(profilePicture.path);
        }
        return res.redirect('/dashboard');
      }

      if (
        user.profileSetupToken !== token ||
        user.profileSetupTokenExpires < Date.now()
      ) {
        if (profilePicture) {
          fs.unlinkSync(profilePicture.path);
        }
        return res.status(400).json({ error: '❌ Invalid or expired profile setup token.' });
      }

      const { fullName, phoneNumber } = req.body;

      // If a new profile picture is uploaded, remove the old one if it exists
      if (profilePicture) {
        if (user.avatar) {
          const oldAvatarPath = path.join(__dirname, user.avatar);
          if (fs.existsSync(oldAvatarPath)) {
            fs.unlinkSync(oldAvatarPath);
          }
        }
        // Save new avatar path
        user.avatar = `/uploads/${profilePicture.filename}`;
      }

      // Update full name and phone number
      user.name = fullName;
      user.phoneNumber = phoneNumber;
      user.profileSetup = true;
      user.profileSetupToken = undefined;
      user.profileSetupTokenExpires = undefined;
      await user.save();

      logger.info(`User profile setup completed: ${user.email}`, { userId: user._id });

      // Redirect to dashboard after successful profile setup
      res.status(200).json({
        message: '✅ Profile setup completed successfully.',
        redirect: '/dashboard',
      });
    } catch (error) {
      if (profilePicture) {
        fs.unlinkSync(profilePicture.path);
      }
      logger.error('Error setting up profile:', error);
      res.status(500).json({ error: '❌ Server error. Please try again later.' });
    }
  })
);

// ========================= Password Reset and Other Features ========================= //

// Additional features like SSO can be implemented here

// ========================= Dashboard Endpoint ========================= //

/**
 * Get Dashboard Data (Admin Only)
 */
app.get(
  '/api/dashboard-data',
  authenticateAdmin,
  asyncHandler(async (req, res) => {
    try {
      const totalUsers = await User.countDocuments();
      const openTickets = await Ticket.countDocuments({ status: 'open' });
      const closedTickets = await Ticket.countDocuments({ status: 'closed' });
      const recentActivities = await ChatMessage.find({})
        .sort({ timestamp: -1 })
        .limit(10)
        .populate('user', 'name email');

      res.json({
        totalUsers,
        openTickets,
        closedTickets,
        recentActivities,
      });
    } catch (error) {
      logger.error('Error fetching dashboard data:', error);
      res.status(500).json({ error: '❌ Internal server error.' });
    }
  })
);

// ========================= Users API (Admin) ========================= //

/**
 * Get All Users (Admin Only)
 */
app.get(
  '/api/users',
  authenticateAdmin,
  asyncHandler(async (req, res) => {
    try {
      const users = await User.find().select('-password').sort({ createdAt: -1 });
      res.json({ users });
    } catch (error) {
      logger.error('Error fetching users:', error);
      res.status(500).json({ error: '❌ Internal server error.' });
    }
  })
);

/**
 * Create New User (Admin Only)
 */
app.post(
  '/api/users',
  authenticateAdmin,
  [
    body('name').trim().notEmpty().withMessage('Name is required.').escape(),
    body('email').isEmail().withMessage('Valid email is required.').normalizeEmail(),
    body('password')
      .isLength({ min: 6 })
      .withMessage('Password must be at least 6 characters long.')
      .escape(),
    body('role').isIn(['user', 'admin']).withMessage('Role must be either user or admin.').escape(),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      logger.warn('Create user failed: Validation errors.', { errors: errors.array() });
      return res.status(400).json({ errors: errors.array() });
    }

    const { name, email, password, role } = req.body;

    try {
      const existingUser = await User.findOne({ email });
      if (existingUser) {
        logger.warn('Create user failed: Email already in use.', { email });
        return res.status(400).json({ error: '❌ Email already in use.' });
      }

      const hashedPassword = await bcrypt.hash(password, parseInt(BCRYPT_SALT_ROUNDS));

      const user = new User({
        name,
        email,
        password: hashedPassword,
        role,
        isVerified: true, // Assuming admin is creating verified users
        profileSetup: false,
      });

      await user.save();
      logger.info('User created:', { email, userId: user._id });
      res.status(201).json({ message: '✅ User created successfully.' });
    } catch (error) {
      logger.error('Create user failed:', error);
      res.status(500).json({ error: '❌ Internal server error.' });
    }
  })
);

/**
 * Update User (Admin Only)
 */
app.put(
  '/api/users/:id',
  authenticateAdmin,
  [
    body('name').optional().trim().notEmpty().withMessage('Name cannot be empty.').escape(),
    body('email').optional().isEmail().withMessage('Valid email is required.').normalizeEmail(),
    body('password')
      .optional()
      .isLength({ min: 6 })
      .withMessage('Password must be at least 6 characters long.')
      .escape(),
    body('role').optional().isIn(['user', 'admin']).withMessage('Role must be either user or admin.').escape(),
    body('status').optional().isIn(['active', 'inactive']).withMessage('Status must be active or inactive.').escape(),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      logger.warn('Update user failed: Validation errors.', { errors: errors.array() });
      return res.status(400).json({ errors: errors.array() });
    }

    const { name, email, password, role, status } = req.body;
    const updateData = {};

    if (name) updateData.name = name;
    if (email) updateData.email = email;
    if (role) updateData.role = role;
    if (status) updateData.status = status;
    if (password) {
      updateData.password = await bcrypt.hash(password, parseInt(BCRYPT_SALT_ROUNDS));
    }

    try {
      const user = await User.findByIdAndUpdate(req.params.id, updateData, {
        new: true,
        runValidators: true,
      });

      if (!user) {
        logger.warn('Update user failed: User not found.', { userId: req.params.id });
        return res.status(404).json({ error: '❌ User not found.' });
      }

      logger.info('User updated:', { email: user.email, userId: user._id });
      res.json({ message: '✅ User updated successfully.' });
    } catch (error) {
      if (error.code === 11000) {
        logger.error('Update user failed: Duplicate email.', { email: req.body.email });
        res.status(400).json({ error: '❌ Email already in use.' });
      } else {
        logger.error('Update user failed:', error);
        res.status(500).json({ error: '❌ Internal server error.' });
      }
    }
  })
);

/**
 * Deactivate User (Admin Only)
 */
app.put(
  '/api/users/:id/deactivate',
  authenticateAdmin,
  asyncHandler(async (req, res) => {
    try {
      const user = await User.findByIdAndUpdate(
        req.params.id,
        { status: 'inactive' },
        { new: true }
      );
      if (!user) {
        logger.warn('Deactivate user failed: User not found.', { userId: req.params.id });
        return res.status(404).json({ error: '❌ User not found.' });
      }

      logger.info('User deactivated:', { email: user.email, userId: user._id });
      res.json({ message: '✅ User deactivated successfully.' });
    } catch (error) {
      logger.error('Deactivate user failed:', error);
      res.status(500).json({ error: '❌ Internal server error.' });
    }
  })
);

// ========================= Tickets API ========================= //

/**
 * Get All Tickets (Admin Only)
 */
app.get(
  '/api/tickets',
  authenticateAdmin,
  asyncHandler(async (req, res) => {
    try {
      const tickets = await Ticket.find().populate('user', 'name email').sort({ createdAt: -1 });
      res.json({ tickets });
    } catch (error) {
      logger.error('Error fetching tickets:', error);
      res.status(500).json({ error: '❌ Internal server error.' });
    }
  })
);

/**
 * Create New Ticket (Authenticated Users)
 */
app.post(
  '/api/tickets',
  authenticateToken,
  [
    body('subject').trim().notEmpty().withMessage('Subject is required.').escape(),
    body('content').trim().notEmpty().withMessage('Content is required.').escape(),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      logger.warn('Create ticket failed: Validation errors.', { errors: errors.array() });
      return res.status(400).json({ errors: errors.array() });
    }

    const { subject, content } = req.body;

    try {
      const ticket = new Ticket({
        subject,
        content,
        user: req.user.id,
      });

      await ticket.save();
      logger.info('Ticket created:', { ticketId: ticket._id, userId: req.user.id });
      res.status(201).json({ message: '✅ Ticket created successfully.' });
    } catch (error) {
      logger.error('Create ticket failed:', error);
      res.status(500).json({ error: '❌ Internal server error.' });
    }
  })
);

/**
 * Close Ticket (Admin Only)
 */
app.put(
  '/api/tickets/:id/close',
  authenticateAdmin,
  asyncHandler(async (req, res) => {
    try {
      const ticket = await Ticket.findByIdAndUpdate(
        req.params.id,
        { status: 'closed' },
        { new: true }
      );
      if (!ticket) {
        logger.warn('Close ticket failed: Ticket not found.', { ticketId: req.params.id });
        return res.status(404).json({ error: '❌ Ticket not found.' });
      }

      logger.info('Ticket closed:', { ticketId: ticket._id });
      res.json({ message: '✅ Ticket closed successfully.' });
    } catch (error) {
      logger.error('Close ticket failed:', error);
      res.status(500).json({ error: '❌ Internal server error.' });
    }
  })
);

// ========================= Guide Endpoints ========================= //

/**
 * Get Popular Guides Sorted by Views
 */
app.get(
  '/apiguides/popular',
  asyncHandler(async (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 6;
      const popularGuides = await Guide.find().sort({ views: -1 }).limit(limit);
      res.json({ guides: popularGuides });
    } catch (error) {
      logger.error('Error fetching popular guides:', error);
      res.status(500).json({ error: '❌ Error fetching popular guides.' });
    }
  })
);

/**
 * Fetch a Guide by Category and Slug
 */
app.get(
  '/apiguides/:category/:slug',
  asyncHandler(async (req, res) => {
    try {
      const { category, slug } = req.params;
      const guide = await Guide.findOne({
        category: new RegExp(`^${category}$`, 'i'),
        slug: new RegExp(`^${slug}$`, 'i'),
      });
      if (!guide) {
        return res.status(404).json({ error: '❌ Guide not found.' });
      }
      res.json(guide);
    } catch (error) {
      logger.error('Error fetching guide by category and slug:', { error, params: req.params });
      res.status(500).json({ error: '❌ Internal Server Error' });
    }
  })
);

/**
 * Fetch a Single Guide by ID
 */
app.get(
  '/apiguides/id/:id',
  asyncHandler(async (req, res) => {
    try {
      const guide = await Guide.findById(req.params.id);
      if (!guide) {
        return res.status(404).json({ error: '❌ Guide not found.' });
      }
      res.json(guide);
    } catch (error) {
      logger.error('Error fetching guide:', error);
      res.status(500).json({ error: '❌ Internal Server Error' });
    }
  })
);

/**
 * Fetch All Guides with Optional Filtering
 */
app.get(
  '/apiguides',
  asyncHandler(async (req, res) => {
    try {
      const { category, tag, search, page = 1, limit = 10 } = req.query;
      let query = {};

      if (category) query.category = new RegExp(category, 'i');
      if (tag) query.tags = new RegExp(tag, 'i');
      if (search) {
        query.$or = [
          { title: new RegExp(search, 'i') },
          { summary: new RegExp(search, 'i') },
          { content: new RegExp(search, 'i') },
        ];
      }

      const guides = await Guide.find(query)
        .skip((page - 1) * limit)
        .limit(parseInt(limit))
        .sort({ createdAt: -1 });

      res.json({ guides });
    } catch (error) {
      logger.error('Error fetching guides:', error);
      res.status(500).json({ error: '❌ Error fetching guides.' });
    }
  })
);

/**
 * Search API for Guides
 * Example: /apiguides/search?q=searchTerm
 */
app.get(
  '/apiguides/search',
  asyncHandler(async (req, res) => {
    const query = req.query.q;
    if (!query) {
      return res.status(400).json({ error: '❌ Query parameter is required.' });
    }

    try {
      const results = await Guide.find({
        $or: [
          { title: { $regex: query, $options: 'i' } },
          { summary: { $regex: query, $options: 'i' } },
          { content: { $regex: query, $options: 'i' } },
        ],
      });

      res.json({ guides: results });
    } catch (error) {
      logger.error('Error searching guides:', error);
      res.status(500).json({ error: '❌ Error searching guides.' });
    }
  })
);

/**
 * Create a New Guide (Authenticated Users)
 */
app.post(
  '/apiguides',
  authenticateToken,
  [
    body('title').trim().notEmpty().withMessage('Title is required.').escape(),
    body('subtitle').optional().trim().escape(),
    body('summary').optional().trim().escape(),
    body('content').trim().notEmpty().withMessage('Content is required.').escape(),
    body('tags').optional().isArray().withMessage('Tags must be an array.'),
    body('tags.*').optional().trim().escape(),
    body('category').trim().notEmpty().withMessage('Category is required.').escape(),
    body('bannerImage').optional().trim().escape(),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      logger.warn('Create guide failed: Validation errors.', { errors: errors.array() });
      return res.status(400).json({ errors: errors.array() });
    }

    const { title, subtitle, summary, content, tags, category, bannerImage } = req.body;

    try {
      const slug = generateSlug(title);

      const newGuide = new Guide({
        title,
        slug,
        subtitle: subtitle || '',
        summary: summary || '',
        content,
        tags: Array.isArray(tags) ? tags : [],
        category,
        bannerImage: bannerImage || '',
        author: {
          id: req.user.id,
          name: req.user.name,
          email: req.user.email,
        },
        publishDate: new Date().toLocaleDateString(),
      });

      const savedGuide = await newGuide.save();
      logger.info(`Guide created: ${title} by ${req.user.email}`, { guideId: savedGuide._id, userId: req.user.id });
      res.status(201).json(savedGuide);
    } catch (error) {
      if (error.code === 11000) {
        logger.error('Create guide failed: Duplicate slug and category.', { title, category });
        res.status(400).json({ error: '❌ A guide with the same title and category already exists.' });
      } else {
        logger.error('Create guide failed:', error);
        res.status(500).json({ error: '❌ Error creating guide.' });
      }
    }
  })
);

/**
 * Update an Existing Guide (Authenticated Users)
 */
app.put(
  '/apiguides/id/:id',
  authenticateToken,
  [
    body('title').optional().trim().notEmpty().withMessage('Title cannot be empty.').escape(),
    body('subtitle').optional().trim().escape(),
    body('summary').optional().trim().escape(),
    body('content').optional().trim().notEmpty().withMessage('Content cannot be empty.').escape(),
    body('tags').optional().isArray().withMessage('Tags must be an array.'),
    body('tags.*').optional().trim().escape(),
    body('category').optional().trim().notEmpty().withMessage('Category cannot be empty.').escape(),
    body('bannerImage').optional().trim().escape(),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      logger.warn('Update guide failed: Validation errors.', { errors: errors.array() });
      return res.status(400).json({ errors: errors.array() });
    }

    const { title, content, category, subtitle, summary, tags, bannerImage } = req.body;
    const updates = {};

    if (title) updates.title = title;
    if (subtitle) updates.subtitle = subtitle;
    if (summary) updates.summary = summary;
    if (content) updates.content = content;
    if (tags) updates.tags = tags;
    if (category) updates.category = category;
    if (bannerImage) updates.bannerImage = bannerImage;

    try {
      if (title) {
        updates.slug = generateSlug(title);
      }

      const updatedGuide = await Guide.findByIdAndUpdate(req.params.id, updates, { new: true, runValidators: true });
      if (!updatedGuide) {
        logger.warn('Update guide failed: Guide not found.', { guideId: req.params.id });
        return res.status(404).json({ error: '❌ Guide not found.' });
      }
      logger.info(`Guide updated: ${updatedGuide.title} by ${req.user.email}`, { guideId: updatedGuide._id, userId: req.user.id });
      res.json(updatedGuide);
    } catch (error) {
      if (error.code === 11000) {
        logger.error('Update guide failed: Duplicate slug and category.', { title, category });
        res.status(400).json({ error: '❌ A guide with the same title and category already exists.' });
      } else {
        logger.error('Update guide failed:', error);
        res.status(500).json({ error: '❌ Error updating guide.' });
      }
    }
  })
);

/**
 * Delete a Guide by ID (Authenticated Users)
 */
app.delete(
  '/apiguides/id/:id',
  authenticateToken,
  asyncHandler(async (req, res) => {
    try {
      const deletedGuide = await Guide.findByIdAndDelete(req.params.id);
      if (!deletedGuide) {
        logger.warn('Delete guide failed: Guide not found.', { guideId: req.params.id });
        return res.status(404).json({ error: '❌ Guide not found.' });
      }
      logger.info(`Guide deleted: ${deletedGuide.title} by ${req.user.email}`, { guideId: deletedGuide._id, userId: req.user.id });
      res.json({ message: '✅ Guide deleted successfully.' });
    } catch (error) {
      logger.error('Delete guide failed:', error);
      res.status(500).json({ error: '❌ Error deleting guide.' });
    }
  })
);

// ==================== Serve Guide Template ====================== //

/**
 * Serve the Guide Page Based on Category and Slug
 */
app.get(
  '/articles/:category/:slug',
  asyncHandler(async (req, res) => {
    const { category, slug } = req.params;

    try {
      const guide = await Guide.findOne({
        category: new RegExp(`^${category}$`, 'i'),
        slug: new RegExp(`^${slug}$`, 'i'),
      });

      if (!guide) {
        return res.status(404).sendFile(path.join(__dirname, 'public', 'error', '404.html'));
      }

      // Increment the view count
      guide.views += 1;
      await guide.save();

      // Serve the guide template with dynamic data (Assuming your frontend handles it)
      res.sendFile(path.join(__dirname, 'public', 'template.html'));
    } catch (error) {
      logger.error('Serve guide failed:', { error, params: req.params });
      res.status(500).sendFile(path.join(__dirname, 'public', 'error', '500.html'));
    }
  })
);

// ==================== Chatbot and Real-time Chat ================== //

/**
 * Chat Routes
 */

/**
 * Get Chat History (Authenticated Users)
 */
app.get(
  '/api/chat/history',
  authenticateToken,
  asyncHandler(async (req, res) => {
    try {
      const messages = await ChatMessage.find({ user: req.user.id }).sort({ timestamp: 1 });
      res.json({ messages });
    } catch (error) {
      logger.error('Error fetching chat history:', error);
      res.status(500).json({ error: '❌ Internal server error.' });
    }
  })
);

/**
 * Send Chat Message (Authenticated Users)
 */
app.post(
  '/api/chat/message',
  authenticateToken,
  [
    body('message').trim().notEmpty().withMessage('Message is required.').escape(),
    body('recipientType')
      .trim()
      .notEmpty()
      .withMessage('Recipient type is required.')
      .isIn(['bot', 'admin'])
      .withMessage('Recipient type must be either bot or admin.')
      .escape(),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      logger.warn('Send chat message failed: Validation errors.', { errors: errors.array() });
      return res.status(400).json({ errors: errors.array() });
    }

    const { message, recipientType } = req.body;

    try {
      const newMessage = new ChatMessage({
        user: req.user.id,
        message,
        sender: 'user',
      });
      await newMessage.save();

      // Emit message via Socket.IO
      io.to(req.user.id).emit('chat message', {
        sender: 'user',
        message,
        timestamp: newMessage.timestamp,
      });

      // Handle bot response if recipientType is 'bot'
      if (recipientType === 'bot') {
        const botResponse = await getBotResponse(message);

        const botMessage = new ChatMessage({
          user: req.user.id,
          message: botResponse,
          sender: 'bot',
        });
        await botMessage.save();

        // Emit bot response via Socket.IO
        io.to(req.user.id).emit('chat message', {
          sender: 'bot',
          message: botResponse,
          timestamp: botMessage.timestamp,
        });

        res.status(200).json({ message: '✅ Message sent and bot response received.' });
      } else if (recipientType === 'admin') {
        // Placeholder for real admin chat implementation
        res.status(200).json({ message: '✅ Message sent to admin.' });
      } else {
        res.status(400).json({ error: '❌ Invalid recipient type.' });
      }
    } catch (error) {
      logger.error('Send chat message failed:', error);
      res.status(500).json({ error: '❌ Internal server error.' });
    }
  })
);

/**
 * Function to get bot response using OpenAI's API
 * (Placeholder function - implement actual API call)
 */
const getBotResponse = async (userMessage) => {
  // TODO: Integrate with OpenAI's API for dynamic responses
  // Example implementation (requires axios and OpenAI API key)
  /*
  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: userMessage }],
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
      }
    );

    const botReply = response.data.choices[0].message.content.trim();
    return botReply;
  } catch (error) {
    logger.error('Error fetching bot response from OpenAI:', error);
    return '🤖 Sorry, I am unable to assist at the moment.';
  }
  */
  // For now, returning a static response
  return `🧠 You said: "${userMessage}". How can I assist you further?`;
};

// ========================= Profile Management ========================= //

/**
 * Get User Profile (Authenticated Users)
 */
app.get(
  '/api/profile',
  authenticateToken,
  asyncHandler(async (req, res) => {
    try {
      const user = await User.findById(req.user.id).select('-password');
      if (!user) {
        return res.status(404).json({ error: '❌ User not found.' });
      }
      res.json({ user });
    } catch (error) {
      logger.error('Get user profile failed:', error);
      res.status(500).json({ error: '❌ Internal server error.' });
    }
  })
);

/**
 * Update User Profile (Authenticated Users)
 */
app.put(
  '/api/profile',
  authenticateToken,
  upload.single('profilePicture'),
  [
    body('name').optional().trim().notEmpty().withMessage('Name cannot be empty.').escape(),
    body('phoneNumber')
      .optional()
      .trim()
      .matches(/^[0-9+\-()\s]+$/)
      .withMessage('Invalid phone number format.')
      .escape(),
    body('bio').optional().trim().escape(),
    body('theme').optional().isIn(['light', 'dark']).withMessage('Theme must be light or dark.').escape(),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    const profilePicture = req.file;

    if (!errors.isEmpty()) {
      // If using multer, file is handled separately
      if (profilePicture) {
        fs.unlinkSync(profilePicture.path);
      }
      logger.warn('Update profile failed: Validation errors.', { errors: errors.array() });
      return res.status(400).json({ errors: errors.array() });
    }

    const { name, phoneNumber, bio, theme } = req.body;

    try {
      const user = await User.findById(req.user.id);
      if (!user) {
        // If using multer, need to remove the uploaded file to prevent orphan files
        if (profilePicture) {
          fs.unlinkSync(profilePicture.path);
        }
        return res.status(404).json({ error: '❌ User not found.' });
      }

      if (profilePicture) {
        if (user.avatar) {
          const oldAvatarPath = path.join(__dirname, user.avatar);
          if (fs.existsSync(oldAvatarPath)) {
            fs.unlinkSync(oldAvatarPath);
          }
        }
        user.avatar = `/uploads/${profilePicture.filename}`;
      }

      if (name) user.name = name;
      if (phoneNumber) user.phoneNumber = phoneNumber;
      if (bio) user.bio = bio;
      if (theme) user.theme = theme;

      await user.save();

      logger.info(`User profile updated: ${user.email}`, { userId: user._id });
      res.json({ message: '✅ Profile updated successfully.' });
    } catch (error) {
      if (profilePicture) {
        fs.unlinkSync(profilePicture.path);
      }
      logger.error('Update profile failed:', error);
      res.status(500).json({ error: '❌ Internal server error.' });
    }
  })
);

// ========================= Error Handling ============================= //

/**
 * 404 Handler for API Routes
 */
app.use('/api', (req, res) => {
  res.status(404).json({ error: '❌ Not found' });
});

/**
 * Error Handler for API Routes
 */
app.use('/api', (err, req, res, next) => {
  logger.error('❌ API Server Error:', err.stack);
  res.status(500).json({ error: '❌ Internal server error' });
});

/**
 * 404 Handler for Non-API Routes
 */
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'public', 'error', '404.html'));
});

/**
 * General Error Handler for Non-API Routes
 */
app.use((err, req, res, next) => {
  logger.error('❌ Server Error:', err.stack);
  res.status(500).sendFile(path.join(__dirname, 'public', 'error', '500.html'));
});

// ================== Socket.IO Setup ==================

io.on('connection', (socket) => {
  logger.info('🔗 User connected via Socket.IO');

  // Join room based on user ID for private messaging
  socket.on('join', (userId) => {
    socket.join(userId);
    logger.info(`User joined room: ${userId}`);
  });

  // Handle chat messages
  socket.on('chat message', async (data) => {
    const { userId, message, sender } = data;
    try {
      const chatMessage = new ChatMessage({
        user: userId,
        message,
        sender,
      });
      await chatMessage.save();

      // Broadcast message to the specific user room
      io.to(userId).emit('chat message', {
        sender,
        message,
        timestamp: chatMessage.timestamp,
      });

      // If sender is admin, you might want to notify the user
      if (sender === 'admin') {
        // Implement any additional logic if needed
      }
    } catch (error) {
      logger.error('Error handling chat message via Socket.IO:', error);
    }
  });

  socket.on('disconnect', () => {
    logger.info('🔌 User disconnected from Socket.IO');
  });
});

// ================== Start the Server ==================

server.listen(PORT, () => {
  logger.info(`🚀 Server is running on port ${PORT}`);
});
