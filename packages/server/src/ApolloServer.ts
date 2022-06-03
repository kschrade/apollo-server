import { isNodeLike } from '@apollo/utils.isnodelike';
import type { Logger } from '@apollo/utils.logger';
import { addMocksToSchema } from '@graphql-tools/mock';
import { makeExecutableSchema } from '@graphql-tools/schema';
import resolvable, { Resolvable } from '@josephg/resolvable';
import {
  assertValidSchema,
  DocumentNode,
  FieldDefinitionNode,
  GraphQLError,
  GraphQLFieldResolver,
  GraphQLFormattedError,
  GraphQLSchema,
  ParseOptions,
  print,
  ValidationContext,
} from 'graphql';
import Keyv from 'keyv';
import loglevel from 'loglevel';
import Negotiator from 'negotiator';
import * as uuid from 'uuid';
import { newCachePolicy } from './cachePolicy';
import { ApolloConfig, determineApolloConfig } from './config';
import { BadRequestError, ensureError, formatApolloErrors } from './errors';
import type {
  ApolloServerPlugin,
  BaseContext,
  GraphQLExecutor,
  GraphQLRequest,
  GraphQLResponse,
  GraphQLServerListener,
  GraphQLServiceContext,
  HTTPGraphQLRequest,
  HTTPGraphQLResponse,
  LandingPage,
  PluginDefinition,
} from './externalTypes';
import type { HTTPGraphQLHead } from './externalTypes/http';
import { runPotentiallyBatchedHttpQuery } from './httpBatching';
import { InternalPluginId, pluginIsInternal } from './internalPlugin';
import {
  ApolloServerPluginCacheControl,
  ApolloServerPluginInlineTrace,
  ApolloServerPluginLandingPageLocalDefault,
  ApolloServerPluginLandingPageProductionDefault,
  ApolloServerPluginSchemaReporting,
  ApolloServerPluginSchemaReportingOptions,
  ApolloServerPluginUsageReporting,
} from './plugin';
import {
  preventCsrf,
  recommendedCsrfPreventionRequestHeaders,
} from './preventCsrf';
import { APQ_CACHE_PREFIX, processGraphQLRequest } from './requestPipeline';
import {
  badMethodErrorMessage,
  cloneObject,
  HeaderMap,
  newHTTPGraphQLHead,
  prettyJSONStringify,
} from './runHttpQuery';
import type {
  ApolloServerOptions,
  ApolloServerOptionsWithStaticSchema,
  DocumentStore,
  PersistedQueryOptions,
  WithRequired,
} from './types';
import { LRUCacheStore, PrefixingKeyv } from './utils/LRUCacheStore';
import { SchemaManager } from './utils/schemaManager';

const NoIntrospection = (context: ValidationContext) => ({
  Field(node: FieldDefinitionNode) {
    if (node.name.value === '__schema' || node.name.value === '__type') {
      context.reportError(
        new GraphQLError(
          'GraphQL introspection is not allowed by Apollo Server, but the query contained __schema or __type. To enable introspection, pass introspection: true to ApolloServer in production',
          [node],
        ),
      );
    }
  },
});

export type SchemaDerivedData = {
  schema: GraphQLSchema;
  // A store that, when enabled (default), will store the parsed and validated
  // versions of operations in-memory, allowing subsequent parses/validates
  // on the same operation to be executed immediately.
  documentStore: DocumentStore | null;
};

type RunningServerState<TContext extends BaseContext> = {
  schemaManager: SchemaManager<TContext>;
  landingPage: LandingPage | null;
};

type ServerState<TContext extends BaseContext> =
  | {
      phase: 'initialized';
      schemaManager: SchemaManager<TContext>;
    }
  | {
      phase: 'starting';
      barrier: Resolvable<void>;
      schemaManager: SchemaManager<TContext>;
      // This is set to true if you called
      // startInBackgroundHandlingStartupErrorsByLoggingAndFailingAllRequests
      // instead of start. The main purpose is that assertStarted allows you to
      // still be in the starting phase if this is set. (This is the serverless
      // use case.)
      startedInBackground: boolean;
    }
  | {
      phase: 'failed to start';
      error: Error;
    }
  | ({
      phase: 'started';
      drainServers: (() => Promise<void>) | null;
      toDispose: (() => Promise<void>)[];
      toDisposeLast: (() => Promise<void>)[];
    } & RunningServerState<TContext>)
  | ({
      phase: 'draining';
      barrier: Resolvable<void>;
    } & RunningServerState<TContext>)
  | {
      phase: 'stopping';
      barrier: Resolvable<void>;
    }
  | {
      phase: 'stopped';
      stopError: Error | null;
    };

// Throw this in places that should be unreachable (because all other cases have
// been handled, reducing the type of the argument to `never`). TypeScript will
// complain if in fact there is a valid type for the argument.
class UnreachableCaseError extends Error {
  constructor(val: never) {
    super(`Unreachable case: ${val}`);
  }
}

export type ContextThunk<TContext extends BaseContext = BaseContext> =
  () => Promise<TContext>;

// TODO(AS4): Move this to its own file or something. Also organize the fields.

export interface ApolloServerInternals<TContext extends BaseContext> {
  formatError?: (
    formattedError: GraphQLFormattedError,
    error: unknown,
  ) => GraphQLFormattedError;
  // TODO(AS4): Is there a way (with generics/codegen?) to make
  // this "any" more specific? In AS3 there was technically a
  // generic for it but it was used inconsistently.
  rootValue?: ((parsedQuery: DocumentNode) => any) | any;
  validationRules: Array<(context: ValidationContext) => any>;
  fieldResolver?: GraphQLFieldResolver<any, TContext>;
  includeStackTracesInErrorResponses: boolean;
  cache: Keyv<string>;
  persistedQueries?: WithRequired<PersistedQueryOptions, 'cache'>;
  nodeEnv: string;
  allowBatchedHttpRequests: boolean;
  logger: Logger;
  apolloConfig: ApolloConfig;
  plugins: ApolloServerPlugin<TContext>[];
  parseOptions: ParseOptions;
  state: ServerState<TContext>;
  // `undefined` means we figure out what to do during _start (because
  // the default depends on whether or not we used the background version
  // of start).
  stopOnTerminationSignals: boolean | undefined;
  executor: GraphQLExecutor<TContext> | null;
  csrfPreventionRequestHeaders: string[] | null;
}

function defaultLogger(): Logger {
  const loglevelLogger = loglevel.getLogger('apollo-server');
  // TODO(AS4): Ensure that migration guide makes it clear that
  // debug:true doesn't set the log level any more.
  loglevelLogger.setLevel(loglevel.levels.INFO);
  return loglevelLogger;
}

export class ApolloServer<TContext extends BaseContext = BaseContext> {
  private internals: ApolloServerInternals<TContext>;

  // We really want to prevent this from being legal:
  //
  //     const s: ApolloServer<{}> =
  //       new ApolloServer<{importantContextField: boolean}>({ ... });
  //     s.executeOperation({query}, {});
  //
  // ie, if you declare an ApolloServer whose context values must be of a
  // certain type, you can't assign it to a variable whose context values are
  // less constrained and then pass in a context value missing important fields.
  // That is, we want ApolloServer to be "contravariant" in TContext. TypeScript
  // just added a feature to implement this directly
  // (https://github.com/microsoft/TypeScript/pull/48240) which we hopefully can
  // use once it's released (ideally down-leveling our generated .d.ts once
  // https://github.com/sandersn/downlevel-dts/issues/73 is implemented). But
  // until then, having a field with a function that takes TContext does the
  // trick. (Why isn't having a method like executeOperation good enough?
  // TypeScript doesn't treat method arguments contravariantly, just standalone
  // functions.)  We have a ts-expect-error test for this behavior (search
  // "contravariant").
  //
  // We only care about the compile-time effects of this field. It is not
  // private because that wouldn't work due to
  // https://github.com/microsoft/TypeScript/issues/38953 We will remove this
  // once `out TContext` is available. Note that when we replace this with `out
  // TContext`, we may make it so that users of older TypeScript versions no
  // longer have this protection.
  //
  // TODO(AS4): upgrade to TS 4.7 when it is released and use that instead.
  protected __forceTContextToBeContravariant?: (contextValue: TContext) => void;

  constructor(config: ApolloServerOptions<TContext>) {
    const nodeEnv = config.nodeEnv ?? process.env.NODE_ENV ?? '';

    const logger = config.logger ?? defaultLogger();

    const apolloConfig = determineApolloConfig(config.apollo);

    const isDev = nodeEnv !== 'production';

    // Plugins will be instantiated if they aren't already, and this.plugins
    // is populated accordingly.
    const plugins = ApolloServer.ensurePluginInstantiation(
      config.plugins,
      isDev,
      apolloConfig,
      logger,
    );

    const state: ServerState<TContext> = config.gateway
      ? // ApolloServer has been initialized but we have not yet tried to load the
        // schema from the gateway. That will wait until `start()` or
        // `startInBackgroundHandlingStartupErrorsByLoggingAndFailingAllRequests()`
        // is called. (These may be called by other helpers; for example,
        // `standaloneServer` calls `start` for you inside its `listen` method,
        // and a serverless framework integration would call
        // startInBackgroundHandlingStartupErrorsByLoggingAndFailingAllRequests
        // for you.)
        {
          phase: 'initialized',
          schemaManager: new SchemaManager({
            gateway: config.gateway,
            apolloConfig,
            schemaDerivedDataProvider: (schema) =>
              ApolloServer.generateSchemaDerivedData(
                schema,
                config.documentStore,
              ),
            logger,
          }),
        }
      : // We construct the schema synchronously so that we can fail fast if the
        // schema can't be constructed. (This used to be more important because we
        // used to have a 'schema' field that was publicly accessible immediately
        // after construction, though that field never actually worked with
        // gateways.)
        {
          phase: 'initialized',
          schemaManager: new SchemaManager({
            apiSchema: ApolloServer.maybeAddMocksToConstructedSchema(
              ApolloServer.constructSchema(config),
              config,
            ),
            schemaDerivedDataProvider: (schema) =>
              ApolloServer.generateSchemaDerivedData(
                schema,
                config.documentStore,
              ),
            logger,
          }),
        };

    const introspectionEnabled = config.introspection ?? isDev;

    // The default internal cache is a vanilla `Keyv` which uses a `Map` by
    // default for its underlying store. For production, we recommend using a
    // more appropriate Keyv implementation (see
    // https://github.com/jaredwray/keyv/tree/main/packages for 1st party
    // maintained Keyv packages or our own Keyv store `LRUCacheStore`).
    // TODO(AS4): warn users and provide better documentation around providing
    // an appropriate Keyv.
    const cache = config.cache ?? new Keyv();

    // Note that we avoid calling methods on `this` before `this.internals` is assigned
    // (thus a bunch of things being static methods above).
    this.internals = {
      formatError: config.formatError,
      rootValue: config.rootValue,
      validationRules: [
        ...(config.validationRules ?? []),
        ...(introspectionEnabled ? [] : [NoIntrospection]),
      ],
      fieldResolver: config.fieldResolver,
      includeStackTracesInErrorResponses:
        config.includeStackTracesInErrorResponses ??
        (nodeEnv !== 'production' && nodeEnv !== 'test'),
      cache,
      persistedQueries:
        config.persistedQueries === false
          ? undefined
          : {
              ...config.persistedQueries,
              cache: new PrefixingKeyv(
                config.persistedQueries?.cache ?? cache,
                APQ_CACHE_PREFIX,
              ),
            },
      nodeEnv,
      allowBatchedHttpRequests: config.allowBatchedHttpRequests ?? false,
      logger,
      apolloConfig,
      plugins,
      parseOptions: config.parseOptions ?? {},
      state,
      stopOnTerminationSignals: config.stopOnTerminationSignals,

      executor: config.executor ?? null, // can be set by _start too

      csrfPreventionRequestHeaders:
        config.csrfPrevention === true || config.csrfPrevention === undefined
          ? recommendedCsrfPreventionRequestHeaders
          : config.csrfPrevention === false
          ? null
          : config.csrfPrevention.requestHeaders ??
            recommendedCsrfPreventionRequestHeaders,
    };
  }

  // Awaiting a call to `start` ensures that a schema has been loaded and that
  // all plugin `serverWillStart` hooks have been called. If either of these
  // processes throw, `start` will (async) throw as well.
  //
  // If you're using `standaloneServer`, you don't need to call `start` yourself
  // (in fact, it will throw if you do so); its `listen` method takes care of
  // that for you.
  //
  // If instead you're using an integration package for a non-serverless
  // framework (like Express), you must await a call to `start` immediately
  // after creating your `ApolloServer`, before attaching it to your web
  // framework and starting to accept requests. `start` should only be called
  // once; if it throws and you'd like to retry, just create another
  // `ApolloServer`. (Calling `start` was optional in Apollo Server 2, but in
  // Apollo Server 3+ the functions like `expressMiddleware` use `assertStarted`
  // to throw if `start` hasn't successfully completed.)
  //
  // Serverless integrations like Lambda do not support calling `start()`,
  // because their lifecycle doesn't allow you to wait before assigning a
  // handler or allowing the handler to be called. So they call
  // `startInBackgroundHandlingStartupErrorsByLoggingAndFailingAllRequests()`
  // instead, and don't really differentiate between startup failures and
  // request failures. This is hopefully appropriate for a "serverless"
  // framework. Serverless startup failures result in returning a redacted error
  // to the end user and logging the more detailed error.
  public async start(): Promise<void> {
    return await this._start(false);
  }

  public startInBackgroundHandlingStartupErrorsByLoggingAndFailingAllRequests(): void {
    this._start(true).catch((e) => this.logStartupError(e));
  }

  protected async _start(startedInBackground: boolean): Promise<void> {
    if (this.internals.state.phase !== 'initialized') {
      // If we wanted we could make this error detectable and change
      // `standaloneServer` to change the message to say not to call start() at
      // all.
      throw new Error(
        `You should only call 'start()' or ` +
          `'startInBackgroundHandlingStartupErrorsByLoggingAndFailingAllRequests()' ` +
          `once on your ApolloServer.`,
      );
    }
    const schemaManager = this.internals.state.schemaManager;
    const barrier = resolvable();
    this.internals.state = {
      phase: 'starting',
      barrier,
      schemaManager,
      startedInBackground,
    };
    try {
      const toDispose: (() => Promise<void>)[] = [];
      const executor = await schemaManager.start();
      if (executor) {
        this.internals.executor = executor;
      }
      toDispose.push(async () => {
        await schemaManager.stop();
      });

      const schemaDerivedData = schemaManager.getSchemaDerivedData();
      const service: GraphQLServiceContext = {
        logger: this.internals.logger,
        schema: schemaDerivedData.schema,
        apollo: this.internals.apolloConfig,
        startedInBackground,
      };

      const taggedServerListeners = (
        await Promise.all(
          this.internals.plugins.map(async (plugin) => ({
            serverListener:
              plugin.serverWillStart && (await plugin.serverWillStart(service)),
            installedImplicitly:
              isImplicitlyInstallablePlugin(plugin) &&
              plugin.__internal_installed_implicitly__,
          })),
        )
      ).filter(
        (
          maybeTaggedServerListener,
        ): maybeTaggedServerListener is {
          serverListener: GraphQLServerListener;
          installedImplicitly: boolean;
        } => typeof maybeTaggedServerListener.serverListener === 'object',
      );

      taggedServerListeners.forEach(
        ({ serverListener: { schemaDidLoadOrUpdate } }) => {
          if (schemaDidLoadOrUpdate) {
            schemaManager.onSchemaLoadOrUpdate(schemaDidLoadOrUpdate);
          }
        },
      );

      const serverWillStops = taggedServerListeners.flatMap((l) =>
        l.serverListener.serverWillStop
          ? [l.serverListener.serverWillStop]
          : [],
      );
      if (serverWillStops.length) {
        toDispose.push(async () => {
          await Promise.all(
            serverWillStops.map((serverWillStop) => serverWillStop()),
          );
        });
      }

      const drainServerCallbacks = taggedServerListeners.flatMap((l) =>
        l.serverListener.drainServer ? [l.serverListener.drainServer] : [],
      );
      const drainServers = drainServerCallbacks.length
        ? async () => {
            await Promise.all(
              drainServerCallbacks.map((drainServer) => drainServer()),
            );
          }
        : null;

      // Find the renderLandingPage callback, if one is provided. If the user
      // installed ApolloServerPluginLandingPageDisabled then there may be none
      // found. On the other hand, if the user installed a landingPage plugin,
      // then both the implicit installation of
      // ApolloServerPluginLandingPage*Default and the other plugin will be
      // found; we skip the implicit plugin.
      let taggedServerListenersWithRenderLandingPage =
        taggedServerListeners.filter((l) => l.serverListener.renderLandingPage);
      if (taggedServerListenersWithRenderLandingPage.length > 1) {
        taggedServerListenersWithRenderLandingPage =
          taggedServerListenersWithRenderLandingPage.filter(
            (l) => !l.installedImplicitly,
          );
      }
      let landingPage: LandingPage | null = null;
      if (taggedServerListenersWithRenderLandingPage.length > 1) {
        throw Error('Only one plugin can implement renderLandingPage.');
      } else if (taggedServerListenersWithRenderLandingPage.length) {
        landingPage = await taggedServerListenersWithRenderLandingPage[0]
          .serverListener.renderLandingPage!();
      }

      const toDisposeLast = this.maybeRegisterTerminationSignalHandlers(
        ['SIGINT', 'SIGTERM'],
        startedInBackground,
      );

      this.internals.state = {
        phase: 'started',
        schemaManager,
        drainServers,
        landingPage,
        toDispose,
        toDisposeLast,
      };
    } catch (maybeError: unknown) {
      const error = ensureError(maybeError);

      try {
        await Promise.all(
          this.internals.plugins.map(async (plugin) =>
            plugin.startupDidFail?.({ error }),
          ),
        );
      } catch (pluginError) {
        this.internals.logger.error(
          `startupDidFail hook threw: ${pluginError}`,
        );
      }

      this.internals.state = {
        phase: 'failed to start',
        error: error,
      };
      throw error;
    } finally {
      barrier.resolve();
    }
  }

  private maybeRegisterTerminationSignalHandlers(
    signals: NodeJS.Signals[],
    startedInBackground: boolean,
  ): (() => Promise<void>)[] {
    const toDisposeLast: (() => Promise<void>)[] = [];

    // We handle signals if it was explicitly requested
    // (stopOnTerminationSignals === true), or if we're in Node, not in a test,
    // not in a serverless framework (which we guess based on whether they
    // called
    // startInBackgroundHandlingStartupErrorsByLoggingAndFailingAllRequests),
    // and it wasn't explicitly turned off. (We only actually register the
    // signal handlers once we've successfully started up, because there's
    // nothing to stop otherwise.)
    if (
      this.internals.stopOnTerminationSignals === false ||
      (this.internals.stopOnTerminationSignals === undefined &&
        !(
          isNodeLike &&
          this.internals.nodeEnv !== 'test' &&
          !startedInBackground
        ))
    ) {
      return toDisposeLast;
    }

    let receivedSignal = false;
    const signalHandler: NodeJS.SignalsListener = async (signal) => {
      if (receivedSignal) {
        // If we receive another SIGINT or SIGTERM while we're waiting
        // for the server to stop, just ignore it.
        return;
      }
      receivedSignal = true;
      try {
        await this.stop();
      } catch (e) {
        this.internals.logger.error(`stop() threw during ${signal} shutdown`);
        this.internals.logger.error(e);
        // Can't rely on the signal handlers being removed.
        process.exit(1);
      }
      // Note: this.stop will call the toDisposeLast handlers below, so at
      // this point this handler will have been removed and we can re-kill
      // ourself to die with the appropriate signal exit status. this.stop
      // takes care to call toDisposeLast last, so the signal handler isn't
      // removed until after the rest of shutdown happens.
      process.kill(process.pid, signal);
    };

    signals.forEach((signal) => {
      process.on(signal, signalHandler);
      toDisposeLast.push(async () => {
        process.removeListener(signal, signalHandler);
      });
    });
    return toDisposeLast;
  }

  // This method is called at the beginning of each GraphQL request by
  // `executeHTTPGraphQLRequest` and `executeOperation`. Most of its logic is
  // only helpful if you started the server in the background (ie, for
  // serverless frameworks): unless you're in a serverless framework, you should
  // have called `await server.start()` before the server got to the point of
  // running GraphQL requests (`assertStarted` calls in the framework
  // integrations verify that) and so the only cases for non-serverless
  // frameworks that this should hit are 'started', 'stopping', and 'stopped'.
  // But if you started the server in the background (with
  // startInBackgroundHandlingStartupErrorsByLoggingAndFailingAllRequests), this
  // lets the server wait until fully started before serving operations.
  private async _ensureStarted(): Promise<RunningServerState<TContext>> {
    while (true) {
      switch (this.internals.state.phase) {
        case 'initialized':
          // This error probably won't happen: serverless framework integrations
          // should call
          // `startInBackgroundHandlingStartupErrorsByLoggingAndFailingAllRequests`
          // for you, and other frameworks call `assertStarted` before setting
          // things up enough to make calling this function possible.
          throw new Error(
            'You need to call `server.start()` before using your Apollo Server.',
          );
        case 'starting':
          await this.internals.state.barrier;
          // continue the while loop
          break;
        case 'failed to start':
          // First we log the error that prevented startup (which means it will
          // get logged once for every GraphQL operation).
          this.logStartupError(this.internals.state.error);
          // Now make the operation itself fail.
          // We intentionally do not re-throw actual startup error as it may contain
          // implementation details and this error will propagate to the client.
          throw new Error(
            'This data graph is missing a valid configuration. More details may be available in the server logs.',
          );
        case 'started':
        case 'draining': // We continue to run operations while draining.
          return this.internals.state;
        case 'stopping':
        case 'stopped':
          this.internals.logger.warn(
            'A GraphQL operation was received during server shutdown. The ' +
              'operation will fail. Consider draining the HTTP server on shutdown; ' +
              'see https://go.apollo.dev/s/drain for details.',
          );
          throw new Error(
            `Cannot execute GraphQL operations ${
              this.internals.state.phase === 'stopping'
                ? 'while the server is stopping'
                : 'after the server has stopped'
            }.'`,
          );
        default:
          throw new UnreachableCaseError(this.internals.state);
      }
    }
  }

  // Framework integrations should call this to ensure that you've properly
  // started your server before you get anywhere close to actually listening for
  // incoming requests.
  //
  // There's a special case that if you called
  // `startInBackgroundHandlingStartupErrorsByLoggingAndFailingAllRequests` and
  // it hasn't finished starting up yet, this works too. This is intended for
  // cases like a serverless integration (say, Google Cloud Functions) that
  // calls
  // `startInBackgroundHandlingStartupErrorsByLoggingAndFailingAllRequests` for
  // you and then immediately sets up an integration based on another middleware
  // like `expressMiddleware` which calls this function. We'd like this to be
  // OK, but we still want normal Express users to start their ApolloServer
  // before setting up their HTTP server unless they know what they are doing
  // well enough to call the function with the long name themselves.
  public assertStarted(expressionForError: string) {
    if (
      this.internals.state.phase !== 'started' &&
      this.internals.state.phase !== 'draining' &&
      !(
        this.internals.state.phase === 'starting' &&
        this.internals.state.startedInBackground
      )
    ) {
      throw new Error(
        'You must `await server.start()` before calling `' +
          expressionForError +
          '`',
      );
    }
  }

  // Given an error that occurred during Apollo Server startup, log it with a
  // helpful message. This should happen when you call
  // `startInBackgroundHandlingStartupErrorsByLoggingAndFailingAllRequests` (ie,
  // in serverless frameworks); with other frameworks, you must `await
  // server.start()` which will throw the startup error directly instead of
  // logging. This gets called both immediately when the startup error happens,
  // and on all subsequent requests.
  private logStartupError(err: Error) {
    this.internals.logger.error(
      'An error occurred during Apollo Server startup. All GraphQL requests ' +
        'will now fail. The startup error was: ' +
        (err?.message || err),
    );
  }

  private static constructSchema<TContext extends BaseContext>(
    config: ApolloServerOptionsWithStaticSchema<TContext>,
  ): GraphQLSchema {
    if (config.schema) {
      return config.schema;
    }

    const { typeDefs, resolvers, parseOptions } = config;
    const augmentedTypeDefs = Array.isArray(typeDefs) ? typeDefs : [typeDefs];

    // For convenience, we allow you to pass a few options that we pass through
    // to a particular version of `@graphql-tools/schema`'s
    // `makeExecutableSchema`. If you want to use more of this function's
    // features or have more control over the version of the packages used, just
    // call it yourself like `new ApolloServer({schema:
    // makeExecutableSchema(...)})`.
    return makeExecutableSchema({
      typeDefs: augmentedTypeDefs,
      resolvers,
      parseOptions,
    });
  }

  private static maybeAddMocksToConstructedSchema<TContext extends BaseContext>(
    schema: GraphQLSchema,
    config: ApolloServerOptionsWithStaticSchema<TContext>,
  ): GraphQLSchema {
    const { mocks, mockEntireSchema } = config;
    if (mocks === false) {
      return schema;
    }
    if (!mocks && typeof mockEntireSchema === 'undefined') {
      return schema;
    }
    return addMocksToSchema({
      schema,
      mocks: mocks === true || typeof mocks === 'undefined' ? {} : mocks,
      preserveResolvers:
        typeof mockEntireSchema === 'undefined' ? false : !mockEntireSchema,
    });
  }

  private static generateSchemaDerivedData(
    schema: GraphQLSchema,
    // null means don't use a documentStore at all.
    // missing/undefined means use the default (creating a new one each
    // time).
    // defined means wrap this one in a random prefix for each new schema.
    providedUnprefixedDocumentStore: DocumentStore | null | undefined,
  ): SchemaDerivedData {
    // Instead of waiting for the first operation execution against the schema
    // to find out if it's a valid schema or not, check right now. In the
    // non-gateway case, if this throws then the `new ApolloServer` call will
    // throw. In the gateway case if this throws then it will log a message and
    // just not update the schema (although oddly the message will claim that
    // the schema is updating).
    assertValidSchema(schema);

    return {
      schema,
      // The DocumentStore is schema-derived because we put documents in it
      // after checking that they pass GraphQL validation against the schema and
      // use this to skip validation as well as parsing. So we can't reuse the
      // same DocumentStore for different schemas because that might make us
      // treat invalid operations as valid. If we're using the default
      // DocumentStore, then we just create it from scratch each time we get a
      // new schema. If we're using a user-provided DocumentStore, then we use a
      // random prefix each time we get a new schema.
      documentStore:
        providedUnprefixedDocumentStore === undefined
          ? new Keyv<DocumentNode>({
              store: new LRUCacheStore({
                // Create ~about~ a 30MiB cache by default. Configurable by providing
                // your own `documentStore`.
                maxSize: Math.pow(2, 20) * 30,
              }),
            })
          : providedUnprefixedDocumentStore === null
          ? null
          : new PrefixingKeyv(providedUnprefixedDocumentStore, `${uuid.v4()}:`),
    };
  }

  public async stop() {
    switch (this.internals.state.phase) {
      case 'initialized':
      case 'starting':
      case 'failed to start':
        throw Error(
          'apolloServer.stop() should only be called after `await apolloServer.start()` has succeeded',
        );

      // Calling stop more than once should have the same result as the first time.
      case 'stopped':
        if (this.internals.state.stopError) {
          throw this.internals.state.stopError;
        }
        return;

      // Two parallel calls to stop; just wait for the other one to finish and
      // do whatever it did.
      case 'stopping':
      case 'draining': {
        await this.internals.state.barrier;
        // The cast here is because TS doesn't understand that this.state can
        // change during the await
        // (https://github.com/microsoft/TypeScript/issues/9998).
        const state = this.internals.state as ServerState<TContext>;
        if (state.phase !== 'stopped') {
          throw Error(`Surprising post-stopping state ${state.phase}`);
        }
        if (state.stopError) {
          throw state.stopError;
        }
        return;
      }

      case 'started':
        // This is handled by the rest of the function.
        break;

      default:
        throw new UnreachableCaseError(this.internals.state);
    }

    const barrier = resolvable();

    const {
      schemaManager,
      drainServers,
      landingPage,
      toDispose,
      toDisposeLast,
    } = this.internals.state;

    // Commit to stopping and start draining servers.
    this.internals.state = {
      phase: 'draining',
      barrier,
      schemaManager,
      landingPage,
    };

    try {
      await drainServers?.();

      // Servers are drained. Prevent further operations from starting and call
      // stop handlers.
      this.internals.state = { phase: 'stopping', barrier };

      // We run shutdown handlers in two phases because we don't want to turn
      // off our signal listeners (ie, allow signals to kill the process) until
      // we've done the important parts of shutdown like running serverWillStop
      // handlers. (We can make this more generic later if it's helpful.)
      await Promise.all([...toDispose].map((dispose) => dispose()));
      await Promise.all([...toDisposeLast].map((dispose) => dispose()));
    } catch (stopError) {
      this.internals.state = {
        phase: 'stopped',
        stopError: stopError as Error,
      };
      barrier.resolve();
      throw stopError;
    }
    this.internals.state = { phase: 'stopped', stopError: null };
  }

  // This is called in the constructor before this.internals has been
  // initialized, so we make it static to make it clear it can't assume that
  // `this` has been fully initialized.
  private static ensurePluginInstantiation<TContext extends BaseContext>(
    userPlugins: PluginDefinition<TContext>[] = [],
    isDev: boolean,
    apolloConfig: ApolloConfig,
    logger: Logger,
  ): ApolloServerPlugin<TContext>[] {
    const plugins = userPlugins.map((plugin) => {
      if (typeof plugin === 'function') {
        return plugin();
      }
      return plugin;
    });

    const alreadyHavePluginWithInternalId = (id: InternalPluginId) =>
      plugins.some(
        (p) => pluginIsInternal(p) && p.__internal_plugin_id__() === id,
      );

    // Special case: cache control is on unless you explicitly disable it.
    {
      if (!alreadyHavePluginWithInternalId('CacheControl')) {
        plugins.push(ApolloServerPluginCacheControl());
      }
    }

    // Special case: usage reporting is on by default (and first!) if you
    // configure an API key.
    {
      const alreadyHavePlugin =
        alreadyHavePluginWithInternalId('UsageReporting');
      if (!alreadyHavePlugin && apolloConfig.key) {
        if (apolloConfig.graphRef) {
          // Keep this plugin first so it wraps everything. (Unfortunately despite
          // the fact that the person who wrote this line also was the original
          // author of the comment above in #1105, they don't quite understand why this was important.)
          plugins.unshift(ApolloServerPluginUsageReporting());
        } else {
          logger.warn(
            'You have specified an Apollo key but have not specified a graph ref; usage ' +
              'reporting is disabled. To enable usage reporting, set the `APOLLO_GRAPH_REF` ' +
              'environment variable to `your-graph-id@your-graph-variant`. To disable this ' +
              'warning, install `ApolloServerPluginUsageReportingDisabled`.',
          );
        }
      }
    }

    // Special case: schema reporting can be turned on via environment variable.
    {
      const alreadyHavePlugin =
        alreadyHavePluginWithInternalId('SchemaReporting');
      const enabledViaEnvVar = process.env.APOLLO_SCHEMA_REPORTING === 'true';
      if (!alreadyHavePlugin && enabledViaEnvVar) {
        if (apolloConfig.key) {
          const options: ApolloServerPluginSchemaReportingOptions = {};
          plugins.push(ApolloServerPluginSchemaReporting(options));
        } else {
          throw new Error(
            "You've enabled schema reporting by setting the APOLLO_SCHEMA_REPORTING " +
              'environment variable to true, but you also need to provide your ' +
              'Apollo API key, via the APOLLO_KEY environment ' +
              'variable or via `new ApolloServer({apollo: {key})',
          );
        }
      }
    }

    // Special case: inline tracing is on by default for federated schemas.
    {
      const alreadyHavePlugin = alreadyHavePluginWithInternalId('InlineTrace');
      if (!alreadyHavePlugin) {
        // If we haven't explicitly disabled inline tracing via
        // ApolloServerPluginInlineTraceDisabled or explicitly installed our own
        // ApolloServerPluginInlineTrace, we set up inline tracing in "only if
        // federated" mode.  (This is slightly different than the
        // pre-ApolloServerPluginInlineTrace where we would also avoid doing
        // this if an API key was configured and log a warning.)
        plugins.push(
          ApolloServerPluginInlineTrace({ __onlyIfSchemaIsFederated: true }),
        );
      }
    }

    // Special case: If we're not in production, show our default landing page.
    //
    // This works a bit differently from the other implicitly installed plugins,
    // which rely entirely on the __internal_plugin_id__ to decide whether the
    // plugin takes effect. That's because we want third-party plugins to be
    // able to provide a landing page that overrides the default landing page,
    // without them having to know about __internal_plugin_id__. So unless we
    // actively disable the default landing page with
    // ApolloServerPluginLandingPageDisabled, we install the default landing
    // page, but with a special flag that _start() uses to ignore it if some
    // other plugin defines a renderLandingPage callback. (We can't just look
    // now to see if the plugin defines renderLandingPage because we haven't run
    // serverWillStart yet.)
    const alreadyHavePlugin = alreadyHavePluginWithInternalId(
      'LandingPageDisabled',
    );
    if (!alreadyHavePlugin) {
      const plugin: ApolloServerPlugin<TContext> = isDev
        ? ApolloServerPluginLandingPageLocalDefault()
        : ApolloServerPluginLandingPageProductionDefault();
      if (!isImplicitlyInstallablePlugin(plugin)) {
        throw Error(
          'default landing page plugin should be implicitly installable?',
        );
      }
      plugin.__internal_installed_implicitly__ = true;
      plugins.push(plugin);
    }

    return plugins;
  }

  public addPlugin(plugin: ApolloServerPlugin<TContext>) {
    if (this.internals.state.phase !== 'initialized') {
      throw new Error("Can't add plugins after the server has started");
    }
    this.internals.plugins.push(plugin);
  }

  // TODO(AS4): Make sure we like the name of this function.
  public async executeHTTPGraphQLRequest({
    httpGraphQLRequest,
    context,
  }: {
    httpGraphQLRequest: HTTPGraphQLRequest;
    context: ContextThunk<TContext>;
  }): Promise<HTTPGraphQLResponse> {
    try {
      let runningServerState;
      try {
        runningServerState = await this._ensureStarted();
      } catch (error: unknown) {
        // This is typically either the masked error from when background startup
        // failed, or related to invoking this function before startup or
        // during/after shutdown (due to lack of draining).
        return this.errorResponse(error);
      }

      if (
        runningServerState.landingPage &&
        this.prefersHTML(httpGraphQLRequest)
      ) {
        return {
          headers: new HeaderMap([['content-type', 'text/html']]),
          completeBody: runningServerState.landingPage.html,
          bodyChunks: null,
        };
      }

      // If enabled, check to ensure that this request was preflighted before doing
      // anything real (such as running the context function).
      if (this.internals.csrfPreventionRequestHeaders) {
        preventCsrf(
          httpGraphQLRequest.headers,
          this.internals.csrfPreventionRequestHeaders,
        );
      }

      let contextValue: TContext;
      try {
        contextValue = await context();
      } catch (maybeError: unknown) {
        const error = ensureError(maybeError);
        try {
          await Promise.all(
            this.internals.plugins.map(async (plugin) =>
              plugin.contextCreationDidFail?.({
                error,
              }),
            ),
          );
        } catch (pluginError) {
          this.internals.logger.error(
            `contextCreationDidFail hook threw: ${pluginError}`,
          );
        }

        error.message = `Context creation failed: ${error.message}`;
        // If we explicitly provide an error code that isn't
        // INTERNAL_SERVER_ERROR, we'll treat it as a client error.
        const statusCode =
          error instanceof GraphQLError &&
          error.extensions.code &&
          error.extensions.code !== 'INTERNAL_SERVER_ERROR'
            ? 400
            : 500;
        return this.errorResponse(error, newHTTPGraphQLHead(statusCode));
      }

      return await runPotentiallyBatchedHttpQuery(
        httpGraphQLRequest,
        contextValue,
        runningServerState.schemaManager.getSchemaDerivedData(),
        this.internals,
      );
    } catch (maybeError_: unknown) {
      const maybeError = maybeError_; // fixes inference because catch vars are not const
      if (maybeError instanceof BadRequestError) {
        try {
          await Promise.all(
            this.internals.plugins.map(async (plugin) =>
              plugin.invalidRequestWasReceived?.({ error: maybeError }),
            ),
          );
        } catch (pluginError) {
          this.internals.logger.error(
            `invalidRequestWasReceived hook threw: ${pluginError}`,
          );
        }
        return this.errorResponse(
          maybeError,
          // Quite hacky, but beats putting more stuff on GraphQLError
          // subclasses, maybe?
          maybeError.message === badMethodErrorMessage
            ? {
                statusCode: 405,
                headers: new HeaderMap([['allow', 'GET, POST']]),
              }
            : newHTTPGraphQLHead(400),
        );
      }
      return this.errorResponse(maybeError);
    }
  }

  private errorResponse(
    error: unknown,
    httpGraphQLHead: HTTPGraphQLHead = newHTTPGraphQLHead(),
  ): HTTPGraphQLResponse {
    return {
      statusCode: httpGraphQLHead.statusCode ?? 500,
      headers: new HeaderMap([
        ...httpGraphQLHead.headers,
        ['content-type', 'application/json'],
      ]),
      completeBody: prettyJSONStringify({
        errors: formatApolloErrors([error], {
          includeStackTracesInErrorResponses:
            this.internals.includeStackTracesInErrorResponses,
          formatError: this.internals.formatError,
        }),
      }),
      bodyChunks: null,
    };
  }

  private prefersHTML(request: HTTPGraphQLRequest): boolean {
    return (
      request.method === 'GET' &&
      new Negotiator({
        headers: { accept: request.headers.get('accept') },
      }).mediaType(['application/json', 'text/html']) === 'text/html'
    );
  }

  /**
   * This method is primarily meant for testing: it allows you to execute a
   * GraphQL operation via the request pipeline without going through the HTTP
   * layer. Note that this means that any handling you do in your server at the
   * HTTP level will not affect this call!
   *
   * For convenience, you can provide `request.query` either as a string or a
   * DocumentNode, in case you choose to use the gql tag in your tests. This is
   * just a convenience, not an optimization (we convert provided ASTs back into
   * string).
   *
   * The second object will be the `contextValue` object available in resolvers.
   */
  // TODO(AS4): document this
  public async executeOperation(
    this: ApolloServer<BaseContext>,
    request: Omit<GraphQLRequest, 'query'> & {
      query?: string | DocumentNode;
    },
  ): Promise<GraphQLResponse>;
  public async executeOperation(
    request: Omit<GraphQLRequest, 'query'> & {
      query?: string | DocumentNode;
    },
    contextValue: TContext,
  ): Promise<GraphQLResponse>;

  async executeOperation(
    request: Omit<GraphQLRequest, 'query'> & {
      query?: string | DocumentNode;
    },
    contextValue?: TContext,
  ): Promise<GraphQLResponse> {
    // Since this function is mostly for testing, you don't need to explicitly
    // start your server before calling it. (That also means you can use it with
    // `apollo-server` which doesn't support `start()`.)
    if (this.internals.state.phase === 'initialized') {
      await this.start();
    }

    const schemaDerivedData = (
      await this._ensureStarted()
    ).schemaManager.getSchemaDerivedData();

    // For convenience, this function lets you pass either a string or an AST,
    // but we normalize to string.
    const graphQLRequest: GraphQLRequest = {
      ...request,
      query:
        request.query && typeof request.query !== 'string'
          ? print(request.query)
          : request.query,
    };

    return await internalExecuteOperation({
      graphQLRequest,
      // The typecast here is safe, because the only way `contextValue` can be
      // null-ish is if we used the `contextValue?: BaseContext` override, in
      // which case TContext is BaseContext and {} is ok. (This does depend on
      // the fact we've hackily forced the class to be contravariant in
      // TContext.)
      contextValue: contextValue ?? ({} as TContext),
      internals: this.internals,
      schemaDerivedData,
    });
  }
}

// Shared code between runHttpQuery (ie executeHTTPGraphQLRequest) and
// executeOperation to set up a request context and invoke the request pipeline.
export async function internalExecuteOperation<TContext extends BaseContext>({
  graphQLRequest,
  contextValue,
  internals,
  schemaDerivedData,
}: {
  graphQLRequest: GraphQLRequest;
  contextValue: TContext;
  internals: ApolloServerInternals<TContext>;
  schemaDerivedData: SchemaDerivedData;
}): Promise<GraphQLResponse> {
  const httpGraphQLHead = newHTTPGraphQLHead();
  httpGraphQLHead.headers.set('content-type', 'application/json');

  const requestContext = {
    logger: internals.logger,
    schema: schemaDerivedData.schema,
    request: graphQLRequest,
    response: { result: {}, http: httpGraphQLHead },
    // We clone the context because there are some assumptions that every operation
    // execution has a brand new context object; specifically, in order to implement
    // willResolveField we put a Symbol on the context that is specific to a particular
    // request pipeline execution. We could avoid this if we had a better way of
    // instrumenting execution.
    //
    // We don't want to do a deep clone here, because one of the main advantages of
    // using batched HTTP requests is to share context across operations for a
    // single request.
    contextValue: cloneObject(contextValue),
    cache: internals.cache,
    metrics: {},
    overallCachePolicy: newCachePolicy(),
  };

  try {
    await processGraphQLRequest(schemaDerivedData, internals, requestContext);
  } catch (maybeError: unknown) {
    // processGraphQLRequest throwing usually means that either there's a bug in
    // Apollo Server or some plugin hook threw unexpectedly.
    const error = ensureError(maybeError);
    // If *these* hooks throw then we'll still get a 500 but won't mask its
    // error.
    await Promise.all(
      internals.plugins.map(async (plugin) =>
        plugin.unexpectedErrorProcessingRequest?.({
          requestContext,
          error,
        }),
      ),
    );
    // Mask unexpected error externally.
    internals.logger.error(`Unexpected error processing request: ${error}`);
    throw new Error('Internal server error');
  }
  return requestContext.response;
}

export type ImplicitlyInstallablePlugin<TContext extends BaseContext> =
  ApolloServerPlugin<TContext> & {
    __internal_installed_implicitly__: boolean;
  };

export function isImplicitlyInstallablePlugin<TContext extends BaseContext>(
  p: ApolloServerPlugin<TContext>,
): p is ImplicitlyInstallablePlugin<TContext> {
  return '__internal_installed_implicitly__' in p;
}