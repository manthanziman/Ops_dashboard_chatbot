require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const dns = require("dns");
const jwt = require("jsonwebtoken");

const { ApolloServer } = require("@apollo/server");
const { expressMiddleware } = require("@as-integrations/express5");
const { graphqlUploadExpress } = require("graphql-upload-minimal");

const {
  typeDefs,
  resolvers,
  permissions,
} = require("./routes/graphql");

const PORT = process.env.PORT || 4000;
const MONGODB_URI = process.env.MONGODB_URI;

dns.setServers(["8.8.8.8", "8.8.4.4"]);

// ------------------------------------------------------------
// Permission wiring
// ------------------------------------------------------------

function applyPermissions(resolverMap, permissionMap) {
  const wrapped = {};

  for (const typeName of Object.keys(resolverMap)) {
    wrapped[typeName] = {};

    for (const fieldName of Object.keys(resolverMap[typeName])) {
      const resolver = resolverMap[typeName][fieldName];
      const permission = permissionMap?.[typeName]?.[fieldName];

      if (typeof permission !== "function") {
        wrapped[typeName][fieldName] = resolver;
        continue;
      }

      wrapped[typeName][fieldName] = async (
        parent,
        args,
        context,
        info
      ) => {
        const allowed = await permission(
          parent,
          args,
          context,
          info
        );

        if (allowed === false) {
          throw new Error("Not authorized");
        }

        return resolver(parent, args, context, info);
      };
    }
  }

  return wrapped;
}

// ------------------------------------------------------------
// MongoDB
// ------------------------------------------------------------

async function connectDB() {
  if (!MONGODB_URI) {
    throw new Error("MONGODB_URI is not defined in the environment.");
  }

  await mongoose.connect(MONGODB_URI);

  console.log("MongoDB connected");
}

// ------------------------------------------------------------
// Server
// ------------------------------------------------------------

async function startServer() {
  await connectDB();

  const app = express();

  app.use(
    cors({
      origin: "http://localhost:5173",
      credentials: true,
    })
  );

  app.use("/graphql", graphqlUploadExpress());
  app.use(express.json());

  const apolloServer = new ApolloServer({
    typeDefs,
    resolvers: applyPermissions(resolvers, permissions),
  });

  await apolloServer.start();

  // ----------------------------------------------------------
  // GraphQL
  // ----------------------------------------------------------

  app.use(
    "/graphql",
    expressMiddleware(apolloServer, {
      context: async ({ req, res }) => {
        const authorization = req.headers.authorization || "";
        const [, token] = authorization.match(/^Bearer\s+(.+)$/i) || [];
        let user = null;

        if (token) {
          try {
            user = jwt.verify(token, process.env.JWT_SECRET);
          } catch {
            user = null;
          }
        }

        return {
          req,
          res,
          user,
          userId: user?.id ?? user?.sub ?? null,
        };
      },
    })
  );

  // ----------------------------------------------------------
  // Health check
  // ----------------------------------------------------------

  app.get("/health", (req, res) => {
    res.status(200).json({
      status: "ok",
    });
  });

  app.listen(PORT, () => {
    console.log(
      `Server ready at http://localhost:${PORT}/graphql`
    );
  });
}

startServer().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});