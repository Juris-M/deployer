/*
 * Uploader/downloader for Juris-M release assets
 */

var fs = require("fs");
var path = require("path");
var mm = require("micromatch");
var fetch = require("node-fetch");
var url = require("url");

var config = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json")).toString());

const { Octokit } = require("@octokit/rest");
const octokit = new Octokit({
    auth: config.access
});

/*
 * Utilities
 */

function chatter(txt) {
    if (!config.quiet) {
        process.stderr.write(txt+"\n");
    }
}

function forceError(txt, e) {
    console.log("deployer: " + txt);
    if (e) {
        console.log(e);
    }
    process.exit(1);
}

function normalizePath(pth) {
    var demandsDirectory = false;
    var fileName = "";
    if (pth.slice(-1) === "/") {
        pth = pth.slice(0, -1);
        demandsDirectory = true;
    }
    if (!fs.existsSync(pth)) {
        if (demandsDirectory) {
            forceError("Path \"" + pth + "\" does not exist");
        } else {
            var pthLst = pth.split("/");
            fileName = pthLst.slice(-1)[0];
            pth = pthLst.slice(0, -1).join("/");
            if (!fs.existsSync(pth)) {
                forceError("Parent directory \"" + pth + "\" does not exist");
            }
        }
    }
    return {
        pathName: pth,
        forceFile: fileName
    }
}

function getFilePaths(pth, exclude) {
    var stats = fs.lstatSync(pth);
    var files = [];
    var isDirectory = stats.isDirectory();
    if (isDirectory) {
        var lst = fs.readdirSync(pth);
        var excludes = mm(lst, exclude);
        for (var fn of fs.readdirSync(pth)) {
            if (fn.slice(-1)[0] === "~") continue;
            if (excludes.indexOf(path.basename(fn)) > -1) continue;
            files.push(path.join(pth, fn));
        }
    } else if (stats.isFile()) {
        files.push(pth);
    } else {
        forceError("Path " + pth + " is neither file nor directory")
    }
    return {
        fileNames: files,
        isDirectory: isDirectory
    }
}

function getTagPaths(tag) {
    tag = tag.split("/");
    if (tag.length === 1 || (tag.length === 2 && !tag[1])) {
        forceError("Invalid tag \"" + tag.join("/") + "\". Tag must consist of multiple elements separated by /");
    }
    var filename = tag.slice(-1)[0];
    tag = tag.slice(0, -1).join("/");
    return {
        tagName: tag,
        assetName: filename
    }
}

function getValidPaths(argv, exclude, downloadOrder) {
    if (downloadOrder) {
        var pathPos = 1;
        var tagPos = 0;
    } else {
        var pathPos = 0;
        var tagPos = 1;
    }
    if (argv.length === 1) {
        var {tagName, assetName} = getTagPaths(argv[tagPos]);
        if (!assetName) {
            forceError("Invalid arguments. Single argument with -d option must be path ending in asset name");
        }
        var dirName = false;
        var fileNames = [];
        var forceFile = false
    } else {
        var {pathName, forceFile} = normalizePath(argv[pathPos]);
        var {fileNames, isDirectory} = getFilePaths(pathName, exclude);
        var {tagName, assetName} = getTagPaths(argv[tagPos]);
        if (isDirectory) {
            if (assetName && !forceFile) {
                forceError("Invalid arguments. Path to directory needs to have tag/ as target (i.e. nothing after the slash)")
            }
            var dirName = pathName;
        } else {
            var dirName = path.dirname(pathName);
            if (forceFile) {
                fileNames = [path.join(dirName, forceFile)]
                
            }
            if (fileNames.length !== 1 || !assetName) {
                forceError("Invalid arguments. Path to file needs explicit tag/asset as target");
            }
        }
    }
    return {
        dirName: dirName,
        fileNames: fileNames,
        tagName: tagName,
        assetName: assetName,
        forceFile: forceFile
    }
}

/*
 * Octokit operations
 */

async function getReleaseParams(tagName){
    // Get a release object
    try {
        var release = await octokit.repos.getReleaseByTag({ owner: "Juris-M", repo: "assets", tag: tagName })
        chatter("Release " + tagName + " already exists, reusing");
    } catch(e) {
        chatter("Release " + tagName + " does not yet exist, creating");
        chatter(JSON.stringify({ owner: "Juris-M", repo: "assets", tag_name: tagName }, null, 2))
        try {
            var release = await octokit.repos.createRelease({ owner: "Juris-M", repo: "assets", tag_name: tagName });
        } catch(e) {
            forceError(e);
        }
    }
    var assetInfo = [];
    for (var asset of release.data.assets) {
        assetInfo.push({
            assetID: asset.id,
            assetName: asset.name,
            assetURL: asset.browser_download_url
        });
    }
    return {
        releaseID: release.data.id,
        uploadTemplate: release.data.upload_url,
        assetInfo: assetInfo
    }
}

async function pushAssets(releaseID, uploadTemplate, fileNames, assetName, contentType) {
    var fileSize, fileContents, urlInfo, uploadParams;
    try {
        //var uploadTemplate
        if (!contentType) {
            contentType = "application/octet-stream";
        }
        if (assetName) {
            fileSize = fs.lstatSync(fileNames[0]).size;
            if (!fileSize) return;
            fileContents = fs.readFileSync(fileNames[0]);
            urlInfo = new url.URL(uploadTemplate);
            uploadParams = {
                owner: "Juris-M",
                repo: "assets",
                release_id: releaseID,
                name: assetName,
                data: fileContents,
                origin: urlInfo.origin
            };
            await octokit.repos.uploadReleaseAsset(uploadParams);
        } else {
            for (var fileName of fileNames) {
                fileSize = fs.lstatSync(fileName).size;
                if (!fileSize) continue;
                assetName = path.basename(fileName);
                urlInfo = new url.URL(uploadTemplate);
                fileContents = fs.readFileSync(fileName);
                uploadParams = {
                    owner: "Juris-M",
                    repo: "assets",
                    release_id: releaseID,
                    name: assetName,
                    data: fileContents,
                    origin: urlInfo.origin
                };
                await octokit.repos.uploadReleaseAsset(uploadParams);
            }
        }
    } catch(e) {
        forceError("Something when wrong on the way to uploading an asset\n" + e);
    }
}

async function removeAssets(filePaths, assetInfo) {
    try {
        var fileNames = filePaths.map(function(pth){
            return path.basename(pth);
        });
        for (var info of assetInfo) {
            if (fileNames.indexOf(info.assetName) === -1) continue;
            await octokit.repos.deleteReleaseAsset({
                owner: "Juris-M",
                repo: "assets",
                asset_id: info.assetID
            });
        }
    } catch(e) {
        forceError(e);
    }
}

/*
 * Public
 */

async function checkAccess() {
    try {
        var result = await octokit.authorization.getAll({
            page: 1,
            per_page: 1
        })
    } catch(e) {
        forceError("Something went wrong with authorization");
    }
    chatter("deployer: repo access OK");
    process.exit(0);
}

async function upload(argv, exclude, contentType) {
    var {fileNames, tagName, assetName} = getValidPaths(argv, exclude);
    var {releaseID, uploadTemplate, assetInfo} = await getReleaseParams(tagName);
    // console.log("deployer: in upload, for releaseID: " + releaseID);

    // Remove assets that have the same name as one of our upload files
    await removeAssets(fileNames, assetInfo);

    // Push our files into the release
    await pushAssets(releaseID, uploadTemplate, fileNames, assetName, contentType)
}

async function download(argv, quiet) {
    try {
        var {dirName, fileNames, tagName, assetName, forceFile} = getValidPaths(argv, null, true);
        var {releaseID, uploadTemplate, assetInfo} = await getReleaseParams(tagName);
        // console.log("deployer: in download, for releaseID: " + releaseID);

        // Download all assets in the target release
        var doneForceFile = false
        for (var info of assetInfo) {
            if (assetName && assetName !== info.assetName) {
                continue;
            } else if (argv.length === 1) {
	        if (!quiet) {
	            console.log(`Call URL [1]: ${info.assetURL}`);
		}
                var res = await fetch(info.assetURL);
                var txt = await res.text();
                fs.writeSync(process.stdout.fd, txt);
                if (txt) {
                    process.exit(0);
                } else {
                    process.exit(1);
                }
                
            } else {
                if (assetName && forceFile) {
                    var fn = forceFile;
                    doneForceFile = true;
                } else {
                    var fn = info.assetName;
                }
            }
	    if (!quiet) {
	        console.log(`Call URL [2]: ${info.assetURL}`);
	    }
            var res = await fetch(info.assetURL);
            var txt = await res.text();
            fs.writeFileSync(path.join(dirName, fn), txt);
        }
        if (assetName && forceFile && !doneForceFile) {
            fs.writeFileSync(path.join(dirName, forceFile), "");
        }

    } catch(e) {
        forceError(e)
    }
}

var opt = require('node-getopt').create([
  ['u' 		, 'upload',   'Upload. Second argument assumed to be tag.'],
  ['d' 		, 'download', 'Download. First argument assumed to be tag/ or tag/asset.'],
  ['x' 		, 'exclude=ARG+',  'Exclude. Ignore files matching glob. Multiple instances allowed. Valid only with -u option.'],
  ['t' 		, 'content_type=ARG',  'contentType. Defaults to application/octet-stream'],
  ['v' 		, 'validate', 'Validate. Check access. Assumes no arguments.'],
  ['q' 		, 'quiet', 'Quiet. Do not produce any chatter.'],
  ['h' 		, 'help'                , 'display this help']
])              // create Getopt instance
.bindHelp()     // bind option 'help' to default action
.parseSystem(); // parse command line

var opt_count = 0;
for (var o of ["download", "upload", "validate"]) {
    if (opt.options[o]) {
        opt_count++;
    }
}

if (opt_count > 1) {
    forceError("Can only select one of -d, -u or -v");
}

if (opt_count === 0) {
    forceError("Must select one of -d, -u or -v");
}

if (opt.options.exclude && !opt.options.upload) {
    forceError("The -x option is available only with -u")
}

if (opt.options.quiet) {
    config.quiet = true;
}

if (opt.options.validate) {
    checkAccess()
}

if (opt.options.upload) {
    if (opt.argv.length !== 2) {
        forceError("Exactly two arguments are required with the -u option");
    }
    upload(opt.argv, opt.options.exclude, opt.options.content_type);
}

if (opt.options.download) {
    if (opt.argv.length < 1 || opt.argv.length > 2) {
        forceError("Either one or two arguments exactly are required with the -d option");
    }
    download(opt.argv, opt.options.quiet);
}
