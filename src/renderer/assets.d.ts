declare module '*.svg' {
  const src: string
  export default src
}
declare module '*?worker' {
  const WorkerFactory: new () => Worker
  export default WorkerFactory
}
