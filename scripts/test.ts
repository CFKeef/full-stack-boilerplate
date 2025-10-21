#!/usr/bin/env tsx

import { exit } from "node:process"

const main = async () => {
    console.log("hello world")
}


main().then(() => {
    console.log("DONE")
}).catch(e => {
    console.error(e)
    exit(-1)
})