import Foundation

public enum WalletNetworkPolicy {
    public static func destination(_ text: String, method: String, operation: String, rpcMethod: String?) -> URL? {
        guard let url = URL(string: text, relativeTo: URL(string: "https://app.merrymen.dev")!)?.absoluteURL,
              url.scheme == "https", url.user == nil, url.password == nil, url.fragment == nil,
              url.port == nil || url.port == 443 else { return nil }
        let reads = ["eth_chainId", "eth_getCode", "eth_call", "eth_getBalance", "eth_getLogs", "eth_blockNumber",
                     "eth_getBlockByNumber", "eth_getTransactionCount", "eth_gasPrice", "eth_maxPriorityFeePerGas",
                     "eth_feeHistory", "eth_estimateGas", "eth_getTransactionReceipt"]
        if url.host == "rpc.mainnet.chain.robinhood.com", ["", "/"].contains(url.path), url.query == nil,
           method == "POST", let rpcMethod, reads.contains(rpcMethod) { return url }
        guard url.host == "app.merrymen.dev", url.query == nil else { return nil }
        if operation == "create" {
            if method == "GET", url.path == "/api/auth/challenge" { return url }
            if method == "POST", url.path == "/api/grants" { return url }
        }
        if ["withdraw", "reconcile"].contains(operation) {
            if url.path == "/api/recover/ticket", ["GET", "POST"].contains(method) { return url }
            let relayReads = ["eth_chainId", "eth_getUserOperationReceipt", "eth_getUserOperationByHash", "eth_estimateUserOperationGas", "pimlico_getUserOperationGasPrice"]
            if url.path == "/api/bundler/4663", method == "POST", let rpcMethod,
               relayReads.contains(rpcMethod) || (operation == "withdraw" && rpcMethod == "eth_sendUserOperation") { return url }
        }
        return nil
    }
}
