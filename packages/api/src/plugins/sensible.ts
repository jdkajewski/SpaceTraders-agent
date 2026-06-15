import fp from 'fastify-plugin';
import sensible from '@fastify/sensible';
import type { FastifyPluginAsync } from 'fastify';

const sensiblePlugin: FastifyPluginAsync = async (fastify) => {
  await fastify.register(sensible);
};

export default fp(sensiblePlugin, { name: 'sensible' });
