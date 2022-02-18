import path from "path"
import { readFile, writeFile, pathExists, mkdirp } from "fs-extra"
import { fetchRemoteFile } from "gatsby-core-utils/fetch-remote-file"
import { createContentDigest } from "gatsby-core-utils/create-content-digest"
import getSharpInstance from "gatsby-sharp"
import { getCache } from "./utils/cache"

export interface IResizeArgs {
  width: number
  height: number
  format: string
  outputPath?: string
}

// Lots of work to get the sharp instance
type Pipeline = ReturnType<Awaited<ReturnType<typeof getSharpInstance>>>

// queue is used inside transformImage to batch multiple transforms together
// more info inside the transformImage function
const queue = new Map<
  string,
  { transforms: Array<IResizeArgs>; promise: Promise<string> }
>()

// eslint-disable-next-line @typescript-eslint/naming-convention
export async function transformImage({
  outputDir,
  args: { url, filename, contentDigest, ...args },
}: {
  outputDir: string
  args: {
    url: string
    filename: string
    width: number
    height: number
    format: string
    fit: import("sharp").FitEnum[keyof import("sharp").FitEnum]
    contentDigest?: string
  }
}): Promise<string> {
  const cache = getCache()

  const digest = createContentDigest({ url, filename, contentDigest, args })
  const cacheKey = `image-cdn:` + digest + `:transform`
  const cachedValue = (await cache.get(cacheKey)) as string | undefined
  if (cachedValue && (await pathExists(cachedValue))) {
    return cachedValue
  }

  const [basename, ext] = filename.split(`.`)
  const filePath = await fetchRemoteFile({
    directory: cache.directory,
    url: url,
    name: basename,
    ext: `.${ext}`,
    cacheKey: contentDigest,
  })

  const outputPath = `${outputDir}/${filename}`
  await mkdirp(path.dirname(outputPath))

  // if the queue already contains the url, we're going to add it to queue so, we can batch the transforms together.
  // We use setImmediate to not block the event loop so the queue can fill up.
  if (queue.has(url)) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const queued = queue.get(url)!

    queued.transforms.push({ ...args, outputPath })

    return queued.promise.then(() => {
      cache.set(cacheKey, outputPath)

      return outputPath
    })
  } else {
    const defer = new Promise<string>((resolve, reject) => {
      setImmediate(async () => {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const transforms = queue.get(url)!.transforms
        queue.delete(url)

        try {
          await resize(await readFile(filePath), transforms)
          await cache.set(cacheKey, outputPath)

          resolve(outputPath)
        } catch (err) {
          reject(err)
        }
      })
    })

    queue.set(url, {
      promise: defer,
      transforms: [{ ...args, outputPath }],
    })

    return defer
  }
}

async function resizeImageWithSharp(
  pipeline: Pipeline | Buffer,
  { width, height, format, outputPath }: IResizeArgs
): Promise<Buffer | void> {
  if (pipeline instanceof Buffer) {
    if (!outputPath) {
      return pipeline
    }

    return writeFile(outputPath, pipeline)
  }

  const resizedImage = pipeline
    .resize(width, height, {})
    .toFormat(
      format as unknown as keyof Awaited<
        ReturnType<typeof getSharpInstance>
      >["format"]
    )

  if (outputPath) {
    await writeFile(outputPath, await resizedImage.toBuffer())
    return undefined
  } else {
    return await resizedImage.toBuffer()
  }
}

async function resize(
  buffer: Buffer,
  transforms: IResizeArgs | Array<IResizeArgs>
): Promise<Buffer | void | Array<Buffer | void>> {
  const sharp = await getSharpInstance()

  let pipeline: Pipeline | undefined
  if (sharp) {
    pipeline = sharp(buffer)
  }

  if (Array.isArray(transforms)) {
    const results: Array<Buffer | void> = []
    for (const transform of transforms) {
      results.push(await resizeImageWithSharp(pipeline ?? buffer, transform))
    }

    return results
  } else {
    return resizeImageWithSharp(pipeline ?? buffer, transforms)
  }
}